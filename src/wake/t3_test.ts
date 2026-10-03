import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { iso } from "../clock.ts";
import { Coordinator } from "../coordinator.ts";
import { UserError } from "../errors.ts";
import type { ResolveResult } from "../ports.ts";
import { SecretVault } from "../redact.ts";
import { Store } from "../store.ts";
import {
  FakeSource,
  forgejoState,
  forgejoWatch,
  tempHome,
} from "../testing.ts";
import type { Delivery } from "../types.ts";
import {
  FileTokenSource,
  prepareTurn,
  T3Wake,
  type TokenSource,
} from "./t3.ts";

const T0 = 1_700_000_000_000;
const TOKEN = "token-tajny-t3";

type TurnSpec = { state: string; at: string; turnId?: string };
type ThreadSpec = {
  id: string;
  provider?: string | null;
  runtime?: string | null;
  interaction?: string | null;
  deleted?: string | null;
  latestTurnId?: string | null;
  sessionId?: string | null;
  providerThreadId?: string | null;
  sessionStatus?: string | null;
  cursor?: { sessionId?: string; threadId?: string } | null;
  runtimeProvider?: string | null;
  turns?: TurnSpec[];
  rowBase?: number;
};

class ScriptTokens implements TokenSource {
  issued = 0;
  invalidations = 0;

  constructor(
    private currentToken: string | null,
    private readonly next: string[],
  ) {}

  current(): Promise<string | null> {
    return Promise.resolve(this.currentToken);
  }

  invalidate(): Promise<void> {
    this.invalidations += 1;
    this.currentToken = null;
    return Promise.resolve();
  }

  issue(): Promise<string> {
    const token = this.next[this.issued];
    this.issued += 1;
    if (!token) {
      return Promise.reject(new UserError("Nie udało się wydać sesji T3."));
    }
    this.currentToken = token;
    return Promise.resolve(token);
  }
}

function schema(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      runtime_mode TEXT,
      interaction_mode TEXT,
      deleted_at TEXT,
      latest_turn_id TEXT
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT
    );
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT,
      resume_cursor_json TEXT
    );
  `);
  return db;
}

function addThread(db: DatabaseSync, spec: ThreadSpec): void {
  const runtime = "runtime" in spec
    ? spec.runtime ?? null
    : "approval-required";
  const interaction = "interaction" in spec ? spec.interaction ?? null : "plan";
  db.prepare(
    `INSERT INTO projection_threads (
      thread_id, runtime_mode, interaction_mode, deleted_at, latest_turn_id
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    spec.id,
    runtime,
    interaction,
    spec.deleted ?? null,
    spec.latestTurnId ?? null,
  );
  const turns = "turns" in spec ? spec.turns ?? [] : [{
    state: "completed",
    at: "2024-01-02T00:00:00.000Z",
    turnId: "latest",
  }];
  turns.forEach((turn, index) => {
    db.prepare(
      `INSERT INTO projection_turns (row_id, thread_id, turn_id, state, requested_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      (spec.rowBase ?? 1) + index,
      spec.id,
      turn.turnId ?? `turn-${index}`,
      turn.state,
      turn.at,
    );
  });
  if (
    spec.provider !== undefined || spec.sessionId || spec.providerThreadId ||
    spec.sessionStatus
  ) {
    db.prepare(
      `INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_session_id, provider_thread_id
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      spec.id,
      spec.sessionStatus ?? "ready",
      spec.provider ?? null,
      spec.sessionId ?? null,
      spec.providerThreadId ?? null,
    );
  }
  if (spec.cursor || spec.runtimeProvider) {
    db.prepare(
      `INSERT INTO provider_session_runtime (thread_id, provider_name, resume_cursor_json)
       VALUES (?, ?, ?)`,
    ).run(
      spec.id,
      spec.runtimeProvider ?? spec.provider ?? null,
      spec.cursor ? JSON.stringify(spec.cursor) : null,
    );
  }
}

async function fixture(build: (db: DatabaseSync) => void): Promise<{
  home: Awaited<ReturnType<typeof tempHome>>;
  database: string;
  runtime: string;
  wake: T3Wake;
  tokens: ScriptTokens;
  calls: Array<{ url: string; init: RequestInit }>;
  vault: SecretVault;
}> {
  const home = await tempHome();
  const database = `${home.root}/t3.sqlite`;
  const runtime = `${home.root}/runtime.json`;
  await Deno.writeTextFile(
    runtime,
    JSON.stringify({ origin: "https://t3.example:8443/api" }),
  );
  const db = schema(database);
  try {
    build(db);
  } finally {
    db.close();
  }
  const tokens = new ScriptTokens(TOKEN, ["token-odnowiony-t3"]);
  const vault = new SecretVault();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const wake = new T3Wake({
    database,
    runtime,
    tokens,
    vault,
    fetch: (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  return { home, database, runtime, wake, tokens, calls, vault };
}

function delivery(): Delivery {
  return {
    id: "d_0123456789abcdef",
    watchId: "w_0123456789ab",
    eventKey: "forgejo:https://git.example.com:acme/dg#363:close:1",
    commandId: "11111111-1111-1111-1111-111111111111",
    messageId: "22222222-2222-2222-2222-222222222222",
    payloadJson: null,
    boundThreadId: null,
    text: "Czujka w_0123456789ab: wykryto forgejo-issue-closed.",
    sourceUrl: "https://git.example.com/acme/dg/issues/363",
    summary: "Zgłoszenie #363 jest zamknięte.",
    detectedAt: iso(T0),
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    acceptedAt: null,
  };
}

function ready(
  result: ResolveResult,
): Extract<ResolveResult, { type: "ready" }> {
  assert.equal(result.type, "ready");
  if (result.type !== "ready") throw new Error("oczekiwano gotowego wątku");
  return result;
}

Deno.test("T3 rozróżnia wątek, sesję dostawcy i tryby trzech providerów", async () => {
  const rig = await fixture((db) => {
    addThread(db, {
      id: "thread-grok",
      provider: "Grok",
      runtime: "approval-required",
      interaction: "plan",
      sessionStatus: "running",
      latestTurnId: "old",
      rowBase: 10,
      turns: [
        { state: "running", at: "2024-01-01T00:00:00.000Z", turnId: "old" },
        { state: "completed", at: "2024-01-03T00:00:00.000Z", turnId: "new" },
      ],
    });
    addThread(db, {
      id: "thread-codex",
      provider: "codex",
      runtime: "workspace-write",
      interaction: "default",
      sessionId: "codex-session",
      sessionStatus: "running",
      rowBase: 20,
      turns: [],
    });
    addThread(db, {
      id: "thread-opencode",
      provider: "opencode",
      runtime: "full-access",
      interaction: "code",
      providerThreadId: "oc-provider-thread",
      cursor: { sessionId: "oc-session" },
      runtimeProvider: "opencode",
      rowBase: 30,
      turns: [
        { state: "running", at: "2024-01-01T00:00:00.000Z" },
        { state: "interrupted", at: "2024-01-01T00:00:00.000Z" },
      ],
    });
  });
  try {
    const grok = ready(await rig.wake.resolve("thread-grok"));
    assert.equal(grok.thread.threadId, "thread-grok");
    assert.equal(grok.thread.provider, "grok");
    assert.equal(grok.thread.runtimeMode, "approval-required");
    assert.equal(grok.thread.interactionMode, "plan");

    const codex = ready(await rig.wake.resolve("codex-session"));
    assert.equal(codex.thread.threadId, "thread-codex");
    assert.notEqual(codex.thread.threadId, "codex-session");
    assert.equal(codex.thread.provider, "codex");
    assert.equal(codex.thread.runtimeMode, "workspace-write");

    const opencode = ready(await rig.wake.resolve("oc-session"));
    assert.equal(opencode.thread.threadId, "thread-opencode");
    assert.equal(opencode.thread.provider, "opencode");
    assert.equal(opencode.thread.interactionMode, "code");
    const byProviderThread = ready(
      await rig.wake.resolve("oc-provider-thread"),
    );
    assert.equal(byProviderThread.thread.threadId, "thread-opencode");

    const payload = prepareTurn(delivery(), grok.thread);
    const body = JSON.parse(payload);
    assert.equal(body.threadId, "thread-grok");
    assert.equal(body.runtimeMode, "approval-required");
    assert.equal(body.interactionMode, "plan");
    assert.equal(payload.includes("full-access"), false);
    assert.equal(body.commandId, delivery().commandId);
    assert.equal(body.createdAt, delivery().detectedAt);
  } finally {
    await rig.home.cleanup();
  }
});

Deno.test("T3: zajętość wynika z ostatniej tury, a braki są błędem", async () => {
  const rig = await fixture((db) => {
    for (const [index, state] of ["running", "starting", "pending"].entries()) {
      addThread(db, {
        id: `busy-${state}`,
        provider: "grok",
        rowBase: 100 + index * 10,
        turns: [{ state, at: "2024-01-02T00:00:00.000Z" }],
      });
    }
    addThread(db, {
      id: "unknown-turn",
      provider: "codex",
      rowBase: 140,
      turns: [{ state: "thinking", at: "2024-01-02T00:00:00.000Z" }],
    });
    addThread(db, {
      id: "no-modes",
      provider: "opencode",
      runtime: null,
      interaction: null,
      rowBase: 150,
    });
    addThread(db, {
      id: "empty-mode",
      provider: "grok",
      runtime: "",
      interaction: "plan",
      rowBase: 160,
    });
    addThread(db, { id: "foreign", provider: "claude", rowBase: 170 });
    addThread(db, {
      id: "split",
      provider: "grok",
      runtimeProvider: "codex",
      rowBase: 180,
    });
    addThread(db, {
      id: "gone",
      provider: "grok",
      deleted: "2024-01-01T00:00:00.000Z",
      sessionId: "deleted-session",
      rowBase: 190,
    });
    addThread(db, {
      id: "shared",
      provider: "grok",
      rowBase: 200,
    });
    addThread(db, {
      id: "other",
      provider: "codex",
      sessionId: "shared",
      rowBase: 210,
    });
    addThread(db, {
      id: "cursor-a",
      provider: "grok",
      cursor: { sessionId: "dup-session" },
      runtimeProvider: "grok",
      rowBase: 220,
    });
    addThread(db, {
      id: "cursor-b",
      provider: "opencode",
      cursor: { threadId: "dup-session" },
      runtimeProvider: "opencode",
      rowBase: 230,
    });
  });
  try {
    for (const state of ["running", "starting", "pending"]) {
      const result = await rig.wake.resolve(`busy-${state}`);
      assert.equal(result.type, "deferred");
      if (result.type === "deferred") {
        assert.match(result.message, new RegExp(state));
      }
    }
    const unknown = await rig.wake.resolve("unknown-turn");
    assert.equal(unknown.type, "deferred");
    if (unknown.type === "deferred") {
      assert.match(unknown.message, /Nieznany stan/);
    }

    for (const id of ["no-modes", "empty-mode"]) {
      const result = await rig.wake.resolve(id);
      assert.equal(result.type, "error");
      if (result.type === "error") {
        assert.match(result.message, /trybu/);
        assert.equal(result.message.includes("full-access"), false);
      }
    }
    const foreign = await rig.wake.resolve("foreign");
    assert.equal(foreign.type, "error");
    if (foreign.type === "error") {
      assert.match(foreign.message, /Codex, OpenCode i Grok/);
    }

    const conflict = await rig.wake.resolve("split");
    assert.equal(conflict.type, "error");
    if (conflict.type === "error") {
      assert.match(conflict.message, /sprzecznych dostawców/);
    }

    const deleted = await rig.wake.resolve("deleted-session");
    assert.equal(deleted.type, "error");
    if (deleted.type === "error") {
      assert.match(deleted.message, /Nie ma takiego wątku/);
    }

    const missing = await rig.wake.resolve("nikogo");
    assert.equal(missing.type, "error");
    if (missing.type === "error") {
      assert.match(missing.message, /Nie ma takiego wątku/);
    }

    for (const id of ["shared", "dup-session"]) {
      const result = await rig.wake.resolve(id);
      assert.equal(result.type, "error");
      if (result.type === "error") {
        assert.match(result.message, /więcej niż jednego/);
      }
    }
  } finally {
    await rig.home.cleanup();
  }
});

Deno.test("T3 jest tylko do odczytu, a brak bazy nie oznacza wolnej sesji", async () => {
  const rig = await fixture((db) => {
    addThread(db, { id: "thread-grok", provider: "grok" });
  });
  try {
    await Deno.chmod(rig.database, 0o444);
    const before = await Deno.readFile(rig.database);
    const result = await rig.wake.resolve("thread-grok");
    assert.equal(result.type, "ready");
    assert.deepEqual(await Deno.readFile(rig.database), before);
    assert.equal(await exists(`${rig.database}-wal`), false);

    const down = new T3Wake({
      database: `${rig.home.root}/brak.sqlite`,
      runtime: rig.runtime,
      tokens: rig.tokens,
      vault: rig.vault,
      fetch: () => Promise.reject(new Error("nie wysyłać")),
    });
    const unavailable = await down.resolve("thread-grok");
    assert.equal(unavailable.type, "error");
    if (unavailable.type === "error") {
      assert.match(unavailable.message, /niedostępne/);
      assert.match(unavailable.message, /nie oznacza, że sesja jest wolna/);
    }
    assert.equal(rig.calls.length, 0);
  } finally {
    await Deno.chmod(rig.database, 0o600).catch(() => {});
    await rig.home.cleanup();
  }
});

Deno.test("wysłanie do T3 rozróżnia przyjęcie, odroczenie, błąd i niejednoznaczność", async () => {
  const home = await tempHome();
  const runtime = `${home.root}/runtime.json`;
  await Deno.writeTextFile(
    runtime,
    JSON.stringify({ origin: "https://t3.example:8443/api" }),
  );
  const database = `${home.root}/empty.sqlite`;
  const db = schema(database);
  db.close();
  const payload = prepareTurn(delivery(), {
    threadId: "thread-grok",
    provider: "grok",
    runtimeMode: "approval-required",
    interactionMode: "plan",
  });
  const calls: Array<
    { url: string; authorization: string | null; body: string | null }
  > = [];
  const script: Array<(auth: string | null) => Response | Promise<Response>> =
    [];
  const tokens = new ScriptTokens(TOKEN, [
    "token-odnowiony-t3",
    "token-zly-t3",
  ]);
  const vault = new SecretVault();
  const wake = new T3Wake({
    database,
    runtime,
    tokens,
    vault,
    fetch: (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ url: String(input), authorization, body });
      assert.equal(init?.redirect, "manual");
      assert.equal(String(input).includes(TOKEN), false);
      const next = script.shift();
      if (!next) return Promise.reject(new Error(`brak odpowiedzi ${TOKEN}`));
      return Promise.resolve(next(authorization));
    },
  });
  try {
    script.push(() => new Response("{}", { status: 200 }));
    assert.deepEqual(await wake.dispatch(payload), { type: "accepted" });
    assert.equal(calls[0].body, payload);
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(
      calls[0].url,
      "https://t3.example:8443/api/orchestration/dispatch",
    );
    assert.equal(tokens.issued, 0);
    const sent = JSON.parse(calls[0].body ?? "{}");
    assert.equal(sent.runtimeMode, "approval-required");
    assert.equal(sent.interactionMode, "plan");
    assert.equal(JSON.stringify(sent).includes("full-access"), false);

    script.push(() => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    });
    const ambiguous = await wake.dispatch(payload);
    assert.equal(ambiguous.type, "ambiguous");
    if (ambiguous.type === "ambiguous") {
      assert.match(ambiguous.message, /nieznany/);
      assert.equal(ambiguous.message.includes(TOKEN), false);
    }
    script.push(() => new Response("{}", { status: 200 }));
    assert.equal((await wake.dispatch(payload)).type, "accepted");
    assert.equal(calls.at(-1)?.body, payload);
    assert.equal(calls[1].body, calls.at(-1)?.body);

    script.push(() => new Response(null, { status: 409 }));
    const busy = await wake.dispatch(payload);
    assert.equal(busy.type, "deferred");
    if (busy.type === "deferred") assert.match(busy.message, /zajętą/);

    script.push((auth) =>
      new Response(auth === `Bearer ${TOKEN}` ? "no" : "ok", {
        status: auth === `Bearer ${TOKEN}` ? 401 : 200,
      })
    );
    script.push((auth) =>
      new Response("ok", {
        status: auth === "Bearer token-odnowiony-t3" ? 200 : 500,
      })
    );
    assert.equal((await wake.dispatch(payload)).type, "accepted");
    assert.equal(tokens.invalidations, 1);
    assert.equal(tokens.issued, 1);
    assert.equal(calls.at(-1)?.authorization, "Bearer token-odnowiony-t3");

    const beforeSecondDenial = calls.length;
    script.push(() => new Response(null, { status: 401 }));
    script.push(() => new Response(null, { status: 401 }));
    const denied = await wake.dispatch(payload);
    assert.equal(denied.type, "error");
    if (denied.type === "error") {
      assert.match(denied.message, /uwierzytelnienie/);
    }
    assert.equal(calls.length, beforeSecondDenial + 2);
    assert.equal(tokens.issued, 2);

    const redirected = calls.length;
    script.push(() =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/take" },
      })
    );
    const moved = await wake.dispatch(payload);
    assert.equal(moved.type, "ambiguous");
    if (moved.type === "ambiguous") {
      assert.match(moved.message, /przekierowało/);
    }
    assert.equal(calls.length, redirected + 1);
    assert.equal(
      calls.some((call) => call.url.includes("evil.example")),
      false,
    );

    script.push(() => new Response("no", { status: 500 }));
    const failed = await wake.dispatch(payload);
    assert.equal(failed.type, "error");
    if (failed.type === "error") assert.match(failed.message, /500/);

    await Deno.writeTextFile(
      runtime,
      JSON.stringify({ origin: "http://user:pass@evil.example/secret" }),
    );
    script.push(() => new Response("{}", { status: 200 }));
    await wake.dispatch(payload);
    assert.equal(
      calls.at(-1)?.url,
      "http://127.0.0.1:4773/api/orchestration/dispatch",
    );
    assert.equal(calls.at(-1)?.url.includes("user:pass"), false);
  } finally {
    await home.cleanup();
  }
});

Deno.test("plik tokenu T3 ma tryb 0600 i nie jest dowiązaniem", async () => {
  const home = await tempHome();
  const path = `${home.root}/t3.token`;
  const source = new FileTokenSource(
    path,
    () => Promise.resolve("token-z-pliku\n"),
  );
  try {
    assert.equal(await source.issue(), "token-z-pliku");
    const info = await Deno.lstat(path);
    assert.equal(info.isSymlink, false);
    assert.equal((info.mode ?? 0) & 0o077, 0);
    await Deno.chmod(path, 0o644);
    assert.equal(await source.current(), "token-z-pliku");
    assert.equal(((await Deno.lstat(path)).mode ?? 0) & 0o077, 0);
    await source.invalidate();
    assert.equal(await exists(path), false);

    await Deno.symlink(`${home.root}/cel`, path);
    await assert.rejects(() => source.current(), /dowiązaniem/);
    await assert.rejects(() => source.issue(), /dowiązaniem/);
    await assert.rejects(() => source.invalidate(), /dowiązaniem/);
    assert.equal((await Deno.lstat(path)).isSymlink, true);

    const wake = new T3Wake({
      database: `${home.root}/brak.sqlite`,
      runtime: `${home.root}/brak.json`,
      tokens: source,
      vault: new SecretVault(),
      fetch: () => Promise.reject(new Error("nie wysyłać")),
    });
    const outcome = await wake.dispatch("{}");
    assert.equal(outcome.type, "error");
    if (outcome.type === "error") assert.match(outcome.message, /dowiązaniem/);
  } finally {
    await home.cleanup();
  }
});

Deno.test("koordynator dostarcza zamrożoną komendę przez T3 dla trzech dostawców", async () => {
  const rig = await fixture((db) => {
    addThread(db, {
      id: "thread-grok",
      provider: "grok",
      runtime: "approval-required",
      interaction: "plan",
    });
    addThread(db, {
      id: "thread-codex",
      provider: "codex",
      runtime: "workspace-write",
      interaction: "default",
      sessionId: "codex-session",
      turns: [],
    });
    addThread(db, {
      id: "thread-opencode",
      provider: "opencode",
      runtime: "full-access",
      interaction: "code",
      cursor: { sessionId: "oc-session" },
      runtimeProvider: "opencode",
      rowBase: 40,
      turns: [{ state: "running", at: "2024-01-01T00:00:00.000Z" }],
    });
  });
  const home = await tempHome();
  const store = Store.open(home.paths.database);
  const sources = new FakeSource();
  sources.script = [
    forgejoState("closed"),
    forgejoState("closed"),
    forgejoState("closed"),
  ];
  const coordinator = new Coordinator(store, sources, rig.wake, rig.vault);
  try {
    store.insertWatch(
      forgejoWatch({
        id: "w_000000000001",
        mode: "once",
        wakeTarget: "thread-grok",
        nextCheckAt: iso(T0),
      }),
    );
    store.insertWatch(
      forgejoWatch({
        id: "w_000000000002",
        mode: "once",
        wakeTarget: "codex-session",
        nextCheckAt: iso(T0),
      }),
    );
    store.insertWatch(
      forgejoWatch({
        id: "w_000000000003",
        mode: "once",
        wakeTarget: "oc-session",
        nextCheckAt: iso(T0),
      }),
    );
    await coordinator.poll(T0);
    await coordinator.flush(T0);
    assert.equal(rig.calls.length, 2);
    const grok = store.listDeliveries("w_000000000001")[0];
    const codex = store.listDeliveries("w_000000000002")[0];
    const opencode = store.listDeliveries("w_000000000003")[0];
    assert.equal(grok.status, "accepted");
    assert.equal(codex.status, "accepted");
    assert.equal(opencode.status, "deferred");
    assert.match(opencode.lastError ?? "", /running/);
    const bodies = rig.calls.map((call) => JSON.parse(String(call.init.body)));
    const grokBody = bodies.find((body) => body.threadId === "thread-grok");
    const codexBody = bodies.find((body) => body.threadId === "thread-codex");
    assert.equal(grokBody.runtimeMode, "approval-required");
    assert.equal(grokBody.interactionMode, "plan");
    assert.equal(grokBody.commandId, grok.commandId);
    assert.equal(grokBody.message.messageId, grok.messageId);
    assert.equal(grokBody.message.text.includes(grok.eventKey), true);
    assert.equal(codexBody.runtimeMode, "workspace-write");
    assert.equal(codexBody.threadId, "thread-codex");
    assert.equal(JSON.stringify(bodies).includes("full-access"), false);

    const writer = new DatabaseSync(rig.database);
    writer.prepare(
      "UPDATE projection_turns SET state = 'completed' WHERE thread_id = ?",
    ).run("thread-opencode");
    writer.close();
    await coordinator.flush(T0);
    assert.equal(rig.calls.length, 2);
    await coordinator.flush(T0 + 15_000);
    assert.equal(rig.calls.length, 3);
    const resent = JSON.parse(String(rig.calls[2].init.body));
    assert.equal(resent.threadId, "thread-opencode");
    assert.equal(resent.interactionMode, "code");
    assert.equal(resent.commandId, opencode.commandId);
    assert.equal(store.getDelivery(opencode.id)?.status, "accepted");
  } finally {
    store.close();
    await home.cleanup();
    await rig.home.cleanup();
  }
});

function exists(path: string): Promise<boolean> {
  return Deno.stat(path).then(() => true, () => false);
}
