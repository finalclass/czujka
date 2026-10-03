import { DatabaseSync } from "node:sqlite";
import { UserError } from "../errors.ts";
import { drain, redirected, send } from "../http.ts";
import type {
  ResolvedThread,
  ResolveResult,
  WakeOutcome,
  WakePort,
} from "../ports.ts";
import { SecretVault } from "../redact.ts";
import { SOURCE_TIMEOUT_MS } from "../schedule.ts";
import type { Delivery } from "../types.ts";

const BUSY = new Set(["running", "starting", "pending"]);
const IDLE = new Set([
  "",
  "completed",
  "interrupted",
  "error",
  "ready",
  "stopped",
  "idle",
  "failed",
  "cancelled",
]);
const PROVIDERS = new Set(["grok", "codex", "opencode"]);
const DEFAULT_ORIGIN = "http://127.0.0.1:4773";

export interface TokenSource {
  current(): Promise<string | null>;
  invalidate(): Promise<void>;
  issue(): Promise<string>;
}

type Candidate = {
  threadId: string;
  provider: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  turnState: string | null;
  deleted: boolean;
};

export function prepareTurn(
  delivery: Delivery,
  thread: ResolvedThread,
): string {
  if (!thread.runtimeMode) {
    throw new UserError("Wątek T3 nie ma trybu uprawnień. Odmowa wybudzenia.");
  }
  if (!thread.interactionMode) {
    throw new UserError("Wątek T3 nie ma trybu interakcji. Odmowa wybudzenia.");
  }
  return JSON.stringify({
    type: "thread.turn.start",
    commandId: delivery.commandId,
    threadId: thread.threadId,
    message: {
      messageId: delivery.messageId,
      role: "user",
      text: delivery.text,
      attachments: [],
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: delivery.detectedAt,
  });
}

export class FileTokenSource implements TokenSource {
  constructor(
    private readonly path: string,
    private readonly issueCommand: () => Promise<string> = issueT3,
  ) {}

  async current(): Promise<string | null> {
    try {
      const info = await Deno.lstat(this.path);
      if (info.isSymlink) {
        throw new UserError("Plik tokenu T3 jest dowiązaniem. Odmowa odczytu.");
      }
      if ((info.mode ?? 0) & 0o077) await Deno.chmod(this.path, 0o600);
      const token = (await Deno.readTextFile(this.path)).trim();
      return token || null;
    } catch (err) {
      if (err instanceof UserError) throw err;
      return null;
    }
  }

  async invalidate(): Promise<void> {
    try {
      const info = await Deno.lstat(this.path);
      if (info.isSymlink) {
        throw new UserError(
          "Plik tokenu T3 jest dowiązaniem. Odmowa usunięcia.",
        );
      }
      await Deno.remove(this.path);
    } catch (err) {
      if (err instanceof UserError) throw err;
    }
  }

  async issue(): Promise<string> {
    const token = (await this.issueCommand()).trim();
    if (!token || /[\r\n]/.test(token)) {
      throw new UserError("Nie udało się wydać sesji T3.");
    }
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = await Deno.lstat(this.path).catch(() => null);
    if (existing?.isSymlink) {
      throw new UserError("Plik tokenu T3 jest dowiązaniem. Odmowa zapisu.");
    }
    await Deno.writeTextFile(this.path, `${token}\n`, { mode: 0o600 });
    await Deno.chmod(this.path, 0o600);
    return token;
  }
}

async function issueT3(): Promise<string> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command("t3", {
      args: [
        "auth",
        "session",
        "issue",
        "--token-only",
        "--ttl",
        "30d",
        "--label",
        "czujka-wake",
        "--subject",
        "czujka",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    throw new UserError("Nie udało się wydać sesji T3.");
  }
  if (!out.success) throw new UserError("Nie udało się wydać sesji T3.");
  return new TextDecoder().decode(out.stdout);
}

export class T3Wake implements WakePort {
  constructor(
    private readonly options: {
      database: string;
      runtime: string;
      tokens: TokenSource;
      fetch: typeof fetch;
      vault: SecretVault;
    },
  ) {}

  resolve(target: string): Promise<ResolveResult> {
    return Promise.resolve(this.lookup(target));
  }

  prepare(delivery: Delivery, thread: ResolvedThread): string {
    return prepareTurn(delivery, thread);
  }

  async dispatch(payload: string): Promise<WakeOutcome> {
    const unknown =
      "Wynik wysłania do T3 jest nieznany. Ponowię tę samą komendę.";
    let token: string;
    try {
      token = (await this.options.tokens.current()) ??
        await this.options.tokens.issue();
      this.options.vault.note(token);
    } catch (err) {
      return this.authError(err, "Nie udało się uwierzytelnić w T3.");
    }
    let response: Response;
    try {
      response = await this.post(payload, token);
    } catch {
      return { type: "ambiguous", message: unknown };
    }
    if (response.status === 401) {
      await drain(response);
      try {
        await this.options.tokens.invalidate();
        token = await this.options.tokens.issue();
        this.options.vault.note(token);
      } catch (err) {
        return this.authError(err, "Nie udało się odnowić sesji T3.");
      }
      try {
        response = await this.post(payload, token);
      } catch {
        return { type: "ambiguous", message: unknown };
      }
    }
    if (redirected(response.status)) {
      await drain(response);
      return {
        type: "ambiguous",
        message: "T3 przekierowało żądanie. Wynik przyjęcia jest nieznany.",
      };
    }
    if (response.ok) {
      await drain(response);
      return { type: "accepted" };
    }
    await drain(response);
    if (response.status === 409) {
      return { type: "deferred", message: "T3 odrzuciło turę jako zajętą." };
    }
    if (response.status === 401) {
      return { type: "error", message: "T3 odrzuciło uwierzytelnienie." };
    }
    return { type: "error", message: `T3 odpowiedziało ${response.status}.` };
  }

  private async post(payload: string, token: string): Promise<Response> {
    const origin = await this.origin();
    return await send(
      this.options.fetch,
      `${origin}/api/orchestration/dispatch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: payload,
      },
      SOURCE_TIMEOUT_MS,
    );
  }

  private async origin(): Promise<string> {
    try {
      const raw = JSON.parse(await Deno.readTextFile(this.options.runtime)) as {
        origin?: unknown;
      };
      if (typeof raw.origin !== "string") return DEFAULT_ORIGIN;
      const url = new URL(raw.origin);
      if (url.username || url.password) return DEFAULT_ORIGIN;
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return DEFAULT_ORIGIN;
      }
      return `${url.protocol}//${url.host}`;
    } catch {
      return DEFAULT_ORIGIN;
    }
  }

  private lookup(target: string): ResolveResult {
    const unavailable = {
      type: "error" as const,
      message: "T3 jest niedostępne. To nie oznacza, że sesja jest wolna.",
    };
    try {
      Deno.statSync(this.options.database);
    } catch {
      return unavailable;
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.options.database, { readOnly: true });
    } catch {
      return unavailable;
    }
    try {
      const found = new Map<string, Candidate>();
      const remember = (row: Record<string, unknown>) => {
        const threadId = stringOf(row.thread_id);
        if (!threadId) return;
        const current = found.get(threadId) ?? {
          threadId,
          provider: null,
          runtimeMode: null,
          interactionMode: null,
          turnState: null,
          deleted: false,
        };
        const provider = stringOf(row.provider_name);
        if (provider) current.provider = provider.toLowerCase();
        const runtime = stringOf(row.runtime_mode);
        if (runtime) current.runtimeMode = runtime;
        const interaction = stringOf(row.interaction_mode);
        if (interaction) current.interactionMode = interaction;
        if (typeof row.turn_state === "string") {
          current.turnState = row.turn_state;
        }
        if (row.deleted_at) current.deleted = true;
        found.set(threadId, current);
      };
      for (
        const row of db.prepare(
          `SELECT t.thread_id, t.runtime_mode, t.interaction_mode, t.deleted_at,
                s.provider_name,
                (SELECT p.state FROM projection_turns p
                  WHERE p.thread_id = t.thread_id
                  ORDER BY p.requested_at DESC, p.row_id DESC LIMIT 1) AS turn_state
         FROM projection_threads t
         LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
         WHERE t.thread_id = ?`,
        ).all(target) as Record<string, unknown>[]
      ) remember(row);
      for (
        const row of db.prepare(
          `SELECT thread_id, provider_name FROM projection_thread_sessions
         WHERE provider_session_id = ? OR provider_thread_id = ?`,
        ).all(target, target) as Record<string, unknown>[]
      ) {
        const threadId = stringOf(row.thread_id);
        if (threadId) {
          this.hydrate(db, threadId, stringOf(row.provider_name), found);
        }
      }
      for (
        const row of db.prepare(
          "SELECT thread_id, provider_name, resume_cursor_json FROM provider_session_runtime",
        ).all() as Record<string, unknown>[]
      ) {
        const cursor = parseCursor(row.resume_cursor_json);
        if (!cursor) continue;
        if (cursor.sessionId !== target && cursor.threadId !== target) continue;
        const threadId = stringOf(row.thread_id);
        if (threadId) {
          this.hydrate(db, threadId, stringOf(row.provider_name), found);
        }
      }
      const live = [...found.values()].filter((item) => !item.deleted);
      if (live.length === 0) {
        return { type: "error", message: "Nie ma takiego wątku T3." };
      }
      if (live.length > 1) {
        return {
          type: "error",
          message: "Identyfikator pasuje do więcej niż jednego wątku T3.",
        };
      }
      const match = live[0];
      const names = this.providerNames(db, match.threadId);
      if (names.length > 1 || match.provider === "conflict") {
        return {
          type: "error",
          message: "Wątek T3 ma sprzecznych dostawców. Nie wybudzam.",
        };
      }
      if (names.length === 1) match.provider = names[0];
      if (!match.provider || !PROVIDERS.has(match.provider)) {
        return {
          type: "error",
          message:
            "Czujka wybudza tylko istniejące sesje Codex, OpenCode i Grok.",
        };
      }
      if (!match.runtimeMode || !match.interactionMode) {
        return {
          type: "error",
          message:
            "Wątek T3 nie ma zapisanego trybu uprawnień albo interakcji.",
        };
      }
      const thread: ResolvedThread = {
        threadId: match.threadId,
        provider: match.provider as ResolvedThread["provider"],
        runtimeMode: match.runtimeMode,
        interactionMode: match.interactionMode,
      };
      const turn = match.turnState ?? "";
      if (BUSY.has(turn)) {
        return { type: "deferred", message: `Sesja T3 jest zajęta (${turn}).` };
      }
      if (!IDLE.has(turn)) {
        return {
          type: "deferred",
          message: `Nieznany stan tury T3 (${turn}). Odkładam dostawę.`,
        };
      }
      return { type: "ready", thread };
    } catch {
      return unavailable;
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  }

  private authError(err: unknown, fallback: string): WakeOutcome {
    const message = err instanceof Error && err.message
      ? err.message
      : fallback;
    return { type: "error", message: this.options.vault.redact(message) };
  }

  private providerNames(db: DatabaseSync, threadId: string): string[] {
    const names = new Set<string>();
    const take = (value: unknown) => {
      const name = stringOf(value);
      if (name) names.add(name.toLowerCase());
    };
    for (
      const row of db.prepare(
        "SELECT provider_name FROM projection_thread_sessions WHERE thread_id = ?",
      ).all(threadId) as Record<string, unknown>[]
    ) take(row.provider_name);
    for (
      const row of db.prepare(
        "SELECT provider_name FROM provider_session_runtime WHERE thread_id = ?",
      ).all(threadId) as Record<string, unknown>[]
    ) take(row.provider_name);
    return [...names];
  }

  private hydrate(
    db: DatabaseSync,
    threadId: string,
    provider: string | null,
    found: Map<string, Candidate>,
  ): void {
    const row = db.prepare(
      `SELECT t.thread_id, t.runtime_mode, t.interaction_mode, t.deleted_at,
              (SELECT p.state FROM projection_turns p
                WHERE p.thread_id = t.thread_id
                ORDER BY p.requested_at DESC, p.row_id DESC LIMIT 1) AS turn_state
       FROM projection_threads t
       WHERE t.thread_id = ?`,
    ).get(threadId) as Record<string, unknown> | undefined;
    if (!row) return;
    if (provider) row.provider_name = provider;
    const current = found.get(threadId);
    if (
      current?.provider && provider &&
      current.provider !== provider.toLowerCase()
    ) {
      found.set(threadId, { ...current, provider: "conflict" });
      return;
    }
    const remembered = {
      thread_id: threadId,
      runtime_mode: row.runtime_mode,
      interaction_mode: row.interaction_mode,
      deleted_at: row.deleted_at,
      provider_name: provider ?? current?.provider,
      turn_state: row.turn_state,
    };
    const threadIdValue = stringOf(remembered.thread_id);
    if (!threadIdValue) return;
    const next: Candidate = found.get(threadIdValue) ?? {
      threadId: threadIdValue,
      provider: null,
      runtimeMode: null,
      interactionMode: null,
      turnState: null,
      deleted: false,
    };
    if (
      typeof remembered.provider_name === "string" && remembered.provider_name
    ) {
      next.provider = remembered.provider_name.toLowerCase();
    }
    if (
      typeof remembered.runtime_mode === "string" && remembered.runtime_mode
    ) {
      next.runtimeMode = remembered.runtime_mode;
    }
    if (
      typeof remembered.interaction_mode === "string" &&
      remembered.interaction_mode
    ) {
      next.interactionMode = remembered.interaction_mode;
    }
    if (typeof remembered.turn_state === "string") {
      next.turnState = remembered.turn_state;
    }
    if (remembered.deleted_at) next.deleted = true;
    found.set(threadIdValue, next);
  }
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseCursor(
  value: unknown,
): { sessionId?: string; threadId?: string } | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as {
      sessionId?: unknown;
      threadId?: unknown;
    };
    return {
      sessionId: typeof parsed.sessionId === "string"
        ? parsed.sessionId
        : undefined,
      threadId: typeof parsed.threadId === "string"
        ? parsed.threadId
        : undefined,
    };
  } catch {
    return null;
  }
}
