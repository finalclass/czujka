import { UserError } from "../errors.ts";
import { drain, redirected, retryAfterMs, send } from "../http.ts";
import { zulipSummary } from "../notify.ts";
import type { SecretLoader } from "../secrets.ts";
import { PAGE_LIMIT, SOURCE_TIMEOUT_MS } from "../schedule.ts";
import type {
  Observation,
  ObservedMessage,
  ZulipCursor,
  ZulipFilters,
} from "../types.ts";
import { SecretVault } from "../redact.ts";

const KEYS = ["ZULIP_SITE", "ZULIP_EMAIL", "ZULIP_API_KEY"];

type ZulipDeps = {
  fetch: typeof fetch;
  secrets: SecretLoader;
  vault: SecretVault;
  now: () => number;
  pageLimit?: number;
};

type ZulipMessage = {
  id: number;
  streamId: number;
  stream: string;
  topic: string;
  from: string;
};

export function normalizeSite(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError("ZULIP_SITE nie jest adresem.");
  }
  if (url.username || url.password) {
    throw new UserError("Adres Zulip nie może zawierać danych logowania.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UserError("Adres Zulip jest nieprawidłowy.");
  }
  if (url.pathname.replace(/\/$/, "")) {
    throw new UserError("ZULIP_SITE powinien być originem, bez ścieżki.");
  }
  return `${url.protocol}//${url.host}`;
}

export async function observeZulip(
  filters: ZulipFilters,
  cursor: ZulipCursor | null,
  deps: ZulipDeps,
): Promise<Observation> {
  let env: Record<string, string>;
  try {
    env = await deps.secrets.load(filters.secretProfile, KEYS);
  } catch (err) {
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof Error ? err.message : "Błąd sekretów.",
      ),
    };
  }
  for (const value of Object.values(env)) deps.vault.note(value);
  const email = env.ZULIP_EMAIL;
  const key = env.ZULIP_API_KEY;
  const siteRaw = env.ZULIP_SITE;
  if (!email || !key || !siteRaw) {
    return {
      type: "error",
      message: "Profil Zulip nie zawiera adresu, konta albo klucza API.",
    };
  }
  let site: string;
  try {
    site = normalizeSite(siteRaw);
  } catch (err) {
    return {
      type: "error",
      message: err instanceof Error ? err.message : "Zły adres Zulip.",
    };
  }
  const auth = basic(email, key);
  try {
    if (!cursor) {
      const streamId = await resolveStream(deps, site, auth, filters.stream);
      const baseline = await watermark(deps, site, auth, filters, streamId);
      return {
        type: "baseline",
        cursor: { kind: "zulip", site, streamId, lastId: baseline },
      };
    }
    if (cursor.site !== site) {
      const streamId = await resolveStream(deps, site, auth, filters.stream);
      const baseline = await watermark(deps, site, auth, filters, streamId);
      return {
        type: "reset",
        cursor: { kind: "zulip", site, streamId, lastId: baseline },
        note:
          "Profil Zulip wskazuje inny serwer niż zapisany punkt startowy. Ustanowiono nowy punkt i nie wczytano historii.",
      };
    }
    const { messages, historyLimited } = await readNew(
      deps,
      site,
      auth,
      filters,
      cursor,
      deps.pageLimit ?? PAGE_LIMIT,
    );
    const observed: ObservedMessage[] = messages.map((message) => ({
      key: `zulip:${site}:${cursor.streamId}:${message.id}`,
      order: message.id,
      summary: zulipSummary(filters.stream, message.topic, message.from),
      url: `${site}/#narrow/near/${message.id}`,
      from: message.from,
      subject: null,
      topic: message.topic,
      stream: filters.stream,
      cursorAfter: {
        kind: "zulip",
        site,
        streamId: cursor.streamId,
        lastId: message.id,
      },
    }));
    const end = observed.at(-1)?.cursorAfter ?? cursor;
    return {
      type: "messages",
      cursor: end,
      messages: observed,
      note: historyLimited
        ? "Zulip ograniczył dostępną historię. Zapisano to w diagnostyce i nie uzupełniono brakujących wiadomości."
        : undefined,
    };
  } catch (err) {
    if (err instanceof UserError && err.message.includes("uwierzytelnienie")) {
      deps.secrets.invalidate?.(filters.secretProfile);
    }
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof Error ? err.message : "Odczyt Zulip nie powiódł się.",
      ),
      retryAfterMs: err instanceof RateLimit ? err.retryAfterMs : undefined,
    };
  }
}

class RateLimit extends UserError {
  constructor(readonly retryAfterMs: number | undefined) {
    super("Zulip ograniczyło częstotliwość zapytań.");
  }
}

async function resolveStream(
  deps: ZulipDeps,
  site: string,
  auth: string,
  name: string,
): Promise<number> {
  const lists = [
    await zulipGet(deps, site, auth, "/api/v1/users/me/subscriptions"),
    await zulipGet(deps, site, auth, "/api/v1/streams"),
  ];
  const ids = new Set<number>();
  for (const body of lists) {
    const rows = [
      ...(Array.isArray(body.subscriptions) ? body.subscriptions : []),
      ...(Array.isArray(body.streams) ? body.streams : []),
    ];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as { name?: unknown; stream_id?: unknown };
      if (item.name === name && Number.isInteger(item.stream_id)) {
        ids.add(item.stream_id as number);
      }
    }
  }
  if (ids.size === 0) {
    throw new UserError(`Nie znaleziono kanału Zulip „${name}”.`);
  }
  if (ids.size > 1) {
    throw new UserError(`Nazwa kanału Zulip „${name}” jest niejednoznaczna.`);
  }
  return [...ids][0];
}

async function watermark(
  deps: ZulipDeps,
  site: string,
  auth: string,
  filters: ZulipFilters,
  streamId: number,
): Promise<number> {
  const body = await messages(
    deps,
    site,
    auth,
    filters,
    streamId,
    "newest",
    true,
    1,
    0,
  );
  const ids = (body.messages as ZulipMessage[])
    .filter((message) => message.streamId === streamId)
    .map((message) => message.id);
  return ids.length ? Math.max(...ids) : 0;
}

async function readNew(
  deps: ZulipDeps,
  site: string,
  auth: string,
  filters: ZulipFilters,
  cursor: ZulipCursor,
  limit: number,
): Promise<{ messages: ZulipMessage[]; historyLimited: boolean }> {
  const collected: ZulipMessage[] = [];
  let historyLimited = false;
  let anchor = cursor.lastId === 0 ? "oldest" : String(cursor.lastId);
  let includeAnchor = cursor.lastId === 0;
  for (let page = 0; page < 5; page++) {
    const body = await messages(
      deps,
      site,
      auth,
      filters,
      cursor.streamId,
      anchor,
      includeAnchor,
      0,
      limit,
    );
    if (body.history_limited === true) historyLimited = true;
    const batch = (body.messages as ZulipMessage[])
      .filter((message) =>
        message.id > cursor.lastId && message.streamId === cursor.streamId
      )
      .sort((a, b) => a.id - b.id);
    const fresh = batch.filter((message) =>
      !collected.some((have) => have.id === message.id)
    );
    collected.push(...fresh);
    const foundNewest = body.found_newest === true;
    if (fresh.length === 0 || foundNewest || fresh.length < limit) break;
    anchor = String(fresh[fresh.length - 1].id);
    includeAnchor = false;
  }
  return { messages: collected, historyLimited };
}

async function messages(
  deps: ZulipDeps,
  site: string,
  auth: string,
  filters: ZulipFilters,
  streamId: number,
  anchor: string,
  includeAnchor: boolean,
  before: number,
  after: number,
): Promise<Record<string, unknown>> {
  const narrow: Array<{ operator: string; operand: string | number }> = [
    { operator: "channel", operand: streamId },
  ];
  if (filters.topic !== null) {
    narrow.push({ operator: "topic", operand: filters.topic });
  }
  const url = new URL("/api/v1/messages", site);
  url.searchParams.set("anchor", anchor);
  url.searchParams.set("num_before", String(before));
  url.searchParams.set("num_after", String(after));
  url.searchParams.set("include_anchor", includeAnchor ? "true" : "false");
  url.searchParams.set("narrow", JSON.stringify(narrow));
  url.searchParams.set("apply_markdown", "false");
  const body = await zulipGet(deps, site, auth, `${url.pathname}${url.search}`);
  const rows = Array.isArray(body.messages) ? body.messages : [];
  body.messages = rows.flatMap((row) => parseMessage(row) ?? []);
  return body;
}

function parseMessage(value: unknown): ZulipMessage | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const type = row.type;
  if (type !== "stream" && type !== "channel") return null;
  if (!Number.isInteger(row.id) || !Number.isInteger(row.stream_id)) {
    return null;
  }
  const stream = typeof row.display_recipient === "string"
    ? row.display_recipient
    : "";
  const topic = typeof row.subject === "string" ? row.subject : "";
  const from = typeof row.sender_email === "string"
    ? row.sender_email
    : typeof row.sender_full_name === "string"
    ? row.sender_full_name
    : "";
  return {
    id: row.id as number,
    streamId: row.stream_id as number,
    stream,
    topic,
    from,
  };
}

async function zulipGet(
  deps: ZulipDeps,
  site: string,
  auth: string,
  pathAndQuery: string,
): Promise<Record<string, unknown>> {
  const url = pathAndQuery.startsWith("http")
    ? pathAndQuery
    : `${site}${pathAndQuery}`;
  let response: Response;
  try {
    response = await send(deps.fetch, url, {
      headers: {
        authorization: auth,
        accept: "application/json",
        "user-agent": "czujka",
      },
    }, SOURCE_TIMEOUT_MS);
  } catch (err) {
    throw new UserError(
      err instanceof Error ? err.message : "Błąd sieci Zulip.",
    );
  }
  if (redirected(response.status)) {
    await drain(response);
    throw new UserError(
      "Zulip przekierowało żądanie. Klucz nie został wysłany dalej.",
    );
  }
  const retry = retryAfterMs(response, deps.now());
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }
  if (response.status === 429 || body.code === "RATE_LIMIT_HIT") {
    throw new RateLimit(retry);
  }
  if (response.status === 401) {
    throw new UserError("Zulip odrzuciło uwierzytelnienie.");
  }
  if (!response.ok || body.result === "error") {
    throw new UserError(`Zulip odpowiedziało ${response.status || "błędem"}.`);
  }
  return body;
}

function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
