import { forgejoOriginFromApi, normalizeOrigin } from "../config.ts";
import { UserError } from "../errors.ts";
import { drain, redirected, retryAfterMs, send } from "../http.ts";
import { forgejoCommentSummary, forgejoPullSummary } from "../notify.ts";
import type { SecretLoader } from "../secrets.ts";
import { SOURCE_TIMEOUT_MS } from "../schedule.ts";
import type {
  ForgejoCommentCursor,
  ForgejoCommentFilters,
  ForgejoFilters,
  ForgejoPullCursor,
  ForgejoPullFilters,
  Observation,
  ObservedMessage,
} from "../types.ts";
import { SecretVault } from "../redact.ts";

const CLOSED_MISS = "To nie oznacza zamknięcia zgłoszenia.";
const COMMENT_MISS = "To nie oznacza nowego komentarza.";
const PULL_MISS = "To nie oznacza aktywności pull requestu.";
const PAGE_LIMIT = 50;
const MAX_PAGES = 20;

const TOKEN_KEYS = ["FORGEJO_TOKEN", "ARCHEA_FORGEJO_TOKEN", "ARCHEA_TOKEN"];
const BASE_KEYS = [
  "FORGEJO_BASE_URL",
  "ARCHEA_FORGEJO_BASE_URL",
  "ARCHEA_BASE_URL",
];
const API_KEYS = [
  "FORGEJO_API_URL",
  "ARCHEA_FORGEJO_API_URL",
  "ARCHEA_API_URL",
];

export function forgejoToken(
  origin: string,
  env: Record<string, string>,
): string {
  const token = pick(env, TOKEN_KEYS);
  if (!token) throw new UserError("Profil Forgejo nie zawiera tokenu.");
  const base = pick(env, BASE_KEYS);
  const api = pick(env, API_KEYS);
  if (!base && !api) {
    throw new UserError(
      "Profil Forgejo nie deklaruje originu. Ustaw FORGEJO_BASE_URL albo FORGEJO_API_URL.",
    );
  }
  if (base && normalizeOrigin(base) !== origin) {
    throw new UserError(
      "Profil Forgejo jest powiązany z innym originem i nie zostanie użyty.",
    );
  }
  if (api && forgejoOriginFromApi(api) !== origin) {
    throw new UserError(
      "Profil Forgejo jest powiązany z innym originem i nie zostanie użyty.",
    );
  }
  return token;
}

function pick(env: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return undefined;
}

type ForgejoDeps = {
  fetch: typeof fetch;
  secrets: SecretLoader;
  vault: SecretVault;
  now: () => number;
};

export async function observeForgejo(
  filters: ForgejoFilters,
  deps: ForgejoDeps,
): Promise<Observation> {
  return await withForgejoToken(
    filters,
    deps,
    (token) => fetchIssue(filters, token, deps),
  );
}

export async function observeForgejoPull(
  filters: ForgejoPullFilters,
  cursor: ForgejoPullCursor | null,
  deps: ForgejoDeps,
): Promise<Observation> {
  return await withForgejoToken(filters, deps, async (token) => {
    const pull = await fetchPull(filters, token, deps);
    if (pull.type === "error") return pull;
    const timeline = await fetchPages(
      `${api(filters)}/issues/${filters.pull}/timeline`,
      token,
      deps,
    );
    if (timeline.type === "error") return timeline;
    const items = parseTimeline(timeline.rows);
    if (items.type === "error") return items;
    const needsReviews = cursor !== null &&
      items.items.some((item) =>
        item.id > cursor.lastId && item.type === "review"
      );
    let reviews = new Map<number, string>();
    if (needsReviews) {
      const listed = await fetchPages(
        `${api(filters)}/pulls/${filters.pull}/reviews`,
        token,
        deps,
      );
      if (listed.type === "error") return listed;
      const parsed = parseReviews(listed.rows);
      if (parsed.type === "error") return parsed;
      reviews = parsed.reviews;
    }
    return classifyPullActivity(
      filters,
      cursor,
      items.items,
      reviews,
      pull.pull,
      deps.vault,
    );
  });
}

export async function observeForgejoComments(
  filters: ForgejoCommentFilters,
  cursor: ForgejoCommentCursor | null,
  deps: ForgejoDeps,
): Promise<Observation> {
  return await withForgejoToken(
    filters,
    deps,
    (token) => fetchComments(filters, cursor, token, deps),
  );
}

async function withForgejoToken(
  target: { profile: string; origin: string },
  deps: ForgejoDeps,
  read: (token: string) => Promise<Observation>,
): Promise<Observation> {
  const first = await loadToken(target, deps);
  if (first.type === "error") return first;
  const observation = await read(first.token);
  if (!(observation.type === "error" && observation.message.includes("401"))) {
    return observation;
  }
  deps.secrets.invalidate?.(target.profile);
  const second = await loadToken(target, deps);
  if (second.type === "error") return second;
  return await read(second.token);
}

type TokenResult =
  | { type: "token"; token: string }
  | { type: "error"; message: string };

async function loadToken(
  target: { profile: string; origin: string },
  deps: ForgejoDeps,
): Promise<TokenResult> {
  let env: Record<string, string>;
  try {
    env = await deps.secrets.load(target.profile, [
      ...TOKEN_KEYS,
      ...BASE_KEYS,
      ...API_KEYS,
    ]);
  } catch (err) {
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof Error ? err.message : "Błąd sekretów.",
      ),
    };
  }
  for (const value of Object.values(env)) deps.vault.note(value);
  try {
    const token = forgejoToken(target.origin, env);
    deps.vault.note(token);
    return { type: "token", token };
  } catch (err) {
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof Error ? err.message : "Błąd profilu Forgejo.",
      ),
    };
  }
}

async function fetchIssue(
  filters: ForgejoFilters,
  token: string,
  deps: ForgejoDeps,
): Promise<Observation> {
  const url = `${filters.origin}/api/v1/repos/${
    encodeURIComponent(filters.owner)
  }/${encodeURIComponent(filters.repo)}/issues/${filters.issue}`;
  const response = await forgejoGet(url, token, deps, CLOSED_MISS, false);
  if (response.type === "error") return response;
  const row = response.body as { state?: unknown; number?: unknown };
  if (row.state !== "open" && row.state !== "closed") {
    return {
      type: "error",
      message:
        "Forgejo nie podało stanu zgłoszenia. To nie oznacza zamknięcia.",
    };
  }
  if (row.number !== filters.issue) {
    return {
      type: "error",
      message: "Forgejo zwróciło inne zgłoszenie. Stan nie został zmieniony.",
    };
  }
  return {
    type: "forgejo",
    state: row.state,
    number: filters.issue,
    url:
      `${filters.origin}/${filters.owner}/${filters.repo}/issues/${filters.issue}`,
  };
}

async function fetchComments(
  filters: ForgejoCommentFilters,
  cursor: ForgejoCommentCursor | null,
  token: string,
  deps: ForgejoDeps,
): Promise<Observation> {
  const url = `${filters.origin}/api/v1/repos/${
    encodeURIComponent(filters.owner)
  }/${encodeURIComponent(filters.repo)}/issues/${filters.issue}/comments`;
  const response = await forgejoGet(url, token, deps, COMMENT_MISS, true);
  if (response.type === "error") return response;
  const parsed = parseComments(response.body, response.total);
  if (parsed.type === "error") return parsed;
  return commentsObservation(filters, cursor, parsed.comments, deps.vault);
}

type ParsedComments =
  | { type: "comments"; comments: IssueComment[] }
  | { type: "error"; message: string };

type IssueComment = {
  id: number;
  author: string;
  body: string;
  html: string;
};

function parseComments(
  body: unknown,
  total: number | null,
): ParsedComments {
  if (!Array.isArray(body)) {
    return {
      type: "error",
      message: `Forgejo nie zwróciło listy komentarzy. ${COMMENT_MISS}`,
    };
  }
  if (total !== null && total !== body.length) {
    return {
      type: "error",
      message:
        `Forgejo podało inną liczbę komentarzy niż zwrócona lista. ${COMMENT_MISS}`,
    };
  }
  const comments: IssueComment[] = [];
  const seen = new Set<number>();
  for (const row of body) {
    if (!row || typeof row !== "object") {
      return {
        type: "error",
        message: `Forgejo zwróciło nieczytelny komentarz. ${COMMENT_MISS}`,
      };
    }
    const item = row as Record<string, unknown>;
    if (!Number.isSafeInteger(item.id) || (item.id as number) <= 0) {
      return {
        type: "error",
        message:
          `Forgejo zwróciło komentarz bez poprawnego identyfikatora. ${COMMENT_MISS}`,
      };
    }
    const id = item.id as number;
    if (seen.has(id)) {
      return {
        type: "error",
        message: `Forgejo powtórzyło identyfikator komentarza. ${COMMENT_MISS}`,
      };
    }
    seen.add(id);
    const user = item.user;
    let author = "";
    if (user && typeof user === "object") {
      const login = (user as { login?: unknown }).login;
      if (typeof login === "string") author = login;
    }
    comments.push({
      id,
      author,
      body: typeof item.body === "string" ? item.body : "",
      html: typeof item.html_url === "string" ? item.html_url : "",
    });
  }
  comments.sort((left, right) => left.id - right.id);
  return { type: "comments", comments };
}

function commentsObservation(
  filters: ForgejoCommentFilters,
  cursor: ForgejoCommentCursor | null,
  comments: IssueComment[],
  vault: SecretVault,
): Observation {
  const max = comments.reduce(
    (highest, comment) => Math.max(highest, comment.id),
    0,
  );
  if (!cursor) {
    return {
      type: "baseline",
      cursor: { kind: "forgejo-comment", lastId: max },
    };
  }
  if (max < cursor.lastId) {
    return {
      type: "messages",
      cursor,
      messages: [],
      note:
        "Najwyższy zapisany komentarz nie jest już na liście. Starszych komentarzy nie uznaję za nowe.",
    };
  }
  const messages: ObservedMessage[] = comments
    .filter((comment) => comment.id > cursor.lastId)
    .map((comment) => ({
      key:
        `forgejo-comment:${filters.origin}:${filters.owner}/${filters.repo}#${filters.issue}:${comment.id}`,
      order: comment.id,
      summary: vault.redact(
        forgejoCommentSummary(filters.issue, comment.author, comment.body),
      ),
      url: commentLink(filters, comment.id, comment.html),
      from: comment.author || null,
      subject: null,
      topic: null,
      stream: null,
      cursorAfter: { kind: "forgejo-comment", lastId: comment.id },
    }));
  const end = messages.at(-1)?.cursorAfter ?? cursor;
  return { type: "messages", cursor: end, messages };
}

function commentLink(
  filters: ForgejoCommentFilters,
  id: number,
  html: string,
): string {
  const fallback =
    `${filters.origin}/${filters.owner}/${filters.repo}/issues/${filters.issue}#issuecomment-${id}`;
  if (!html) return fallback;
  let url: URL;
  try {
    url = new URL(html);
  } catch {
    return fallback;
  }
  if (url.username || url.password || url.search) return fallback;
  if (`${url.protocol}//${url.host}` !== filters.origin) return fallback;
  return `${url.origin}${url.pathname}${url.hash}`;
}

type PullSnapshot = { merged: boolean; html: string };

type PullTimelineItem = {
  id: number;
  type: string;
  author: string;
  body: string;
  html: string;
  reviewId: number | null;
};

type PullKind = "approved" | "changes" | "closed" | "merged" | "comment";

export function classifyPullActivity(
  filters: ForgejoPullFilters,
  cursor: ForgejoPullCursor | null,
  items: PullTimelineItem[],
  reviewStates: ReadonlyMap<number, string>,
  pull: PullSnapshot,
  vault: SecretVault,
): Observation {
  const sorted = [...items].sort((left, right) => left.id - right.id);
  const seen = new Set<number>();
  for (const item of sorted) {
    if (seen.has(item.id)) {
      return pullError("Forgejo powtórzyło wpis osi czasu.");
    }
    seen.add(item.id);
  }
  const max = sorted.reduce((highest, item) => Math.max(highest, item.id), 0);
  if (cursor && max < cursor.lastId) {
    return {
      type: "messages",
      cursor,
      messages: [],
      note:
        "Najwyższy zapisany wpis osi czasu nie jest już na liście. Starszych wpisów nie uznaję za nowe.",
    };
  }
  let pending = false;
  let sawMerge = false;
  const messages: ObservedMessage[] = [];
  for (const item of sorted) {
    if (item.type === "merge_pull") {
      pending = true;
      sawMerge = true;
      if (isNew(cursor, item.id) && !cursor?.merged) {
        messages.push(pullMessage(filters, item, "merged", vault));
      }
      continue;
    }
    if (item.type === "reopen") {
      pending = false;
      continue;
    }
    if (item.type === "close") {
      const laterReopen = sorted.some((later) =>
        later.id > item.id && later.type === "reopen"
      );
      const companion = pending || (pull.merged && !laterReopen);
      pending = false;
      if (!companion && isNew(cursor, item.id)) {
        messages.push(pullMessage(filters, item, "closed", vault));
      }
      continue;
    }
    if (!isNew(cursor, item.id)) continue;
    if (item.type === "comment") {
      messages.push(pullMessage(filters, item, "comment", vault));
      continue;
    }
    if (item.type !== "review") continue;
    const decision = reviewDecision(item, reviewStates);
    if (decision.type === "error") return pullError(decision.message);
    if (decision.type === "skip") continue;
    messages.push(pullMessage(filters, item, decision.kind, vault));
  }
  const end: ForgejoPullCursor = {
    kind: "forgejo-pull",
    lastId: max,
    mergePendingClose: pending,
    merged: pull.merged || sawMerge || cursor?.merged === true,
  };
  if (!cursor) return { type: "baseline", cursor: end };
  if (pull.merged && !cursor.merged && !sawMerge) {
    messages.push({
      key: pullKey(filters, "merged", "merged"),
      order: max + 1,
      summary: vault.redact(forgejoPullSummary(filters.pull, "merged", "", "")),
      url: safePullUrl(filters, null, pull.html),
      from: null,
      subject: null,
      topic: null,
      stream: null,
      cursorAfter: { ...end, merged: true },
    });
    end.merged = true;
    end.mergePendingClose = true;
  }
  if (messages.length > 0) {
    messages[messages.length - 1].cursorAfter = end;
  }
  return { type: "messages", cursor: end, messages };
}

function isNew(cursor: ForgejoPullCursor | null, id: number): boolean {
  return cursor !== null && id > cursor.lastId;
}

function reviewDecision(
  item: PullTimelineItem,
  reviewStates: ReadonlyMap<number, string>,
): { type: "kind"; kind: PullKind } | { type: "skip" } | {
  type: "error";
  message: string;
} {
  if (item.reviewId === null) {
    return {
      type: "error",
      message: "Forgejo zwróciło recenzję bez identyfikatora.",
    };
  }
  const state = reviewStates.get(item.reviewId);
  if (state === undefined) {
    return {
      type: "error",
      message: "Forgejo nie podało stanu recenzji.",
    };
  }
  if (state === "APPROVED") return { type: "kind", kind: "approved" };
  if (state === "REQUEST_CHANGES") return { type: "kind", kind: "changes" };
  if (state === "COMMENT") return { type: "kind", kind: "comment" };
  if (state === "PENDING" || state === "REQUEST_REVIEW") {
    return { type: "skip" };
  }
  return {
    type: "error",
    message: "Forgejo podało nieznany stan recenzji.",
  };
}

function pullMessage(
  filters: ForgejoPullFilters,
  item: PullTimelineItem,
  kind: PullKind,
  vault: SecretVault,
): ObservedMessage {
  return {
    key: pullKey(filters, kind, item.id),
    order: item.id,
    summary: vault.redact(
      forgejoPullSummary(filters.pull, kind, item.author, item.body),
    ),
    url: safePullUrl(filters, item.id, item.html),
    from: item.author || null,
    subject: null,
    topic: null,
    stream: null,
    cursorAfter: {
      kind: "forgejo-pull",
      lastId: item.id,
      mergePendingClose: false,
      merged: false,
    },
  };
}

function pullKey(
  filters: ForgejoPullFilters,
  kind: string,
  id: number | "merged",
): string {
  return `forgejo-pull:${filters.origin}:${filters.owner}/${filters.repo}#${filters.pull}:${kind}:${id}`;
}

function safePullUrl(
  filters: ForgejoPullFilters,
  id: number | null,
  html: string,
): string {
  const fallback = id === null
    ? `${filters.origin}/${filters.owner}/${filters.repo}/pulls/${filters.pull}`
    : `${filters.origin}/${filters.owner}/${filters.repo}/pulls/${filters.pull}#issuecomment-${id}`;
  if (!html) return fallback;
  let url: URL;
  try {
    url = new URL(html);
  } catch {
    return fallback;
  }
  if (url.username || url.password || url.search) return fallback;
  if (`${url.protocol}//${url.host}` !== filters.origin) return fallback;
  return `${url.origin}${url.pathname}${url.hash}`;
}

function pullError(message: string): {
  type: "error";
  message: string;
} {
  return { type: "error", message: `${message} ${PULL_MISS}` };
}

function api(filters: ForgejoPullFilters): string {
  return `${filters.origin}/api/v1/repos/${encodeURIComponent(filters.owner)}/${
    encodeURIComponent(filters.repo)
  }`;
}

async function fetchPull(
  filters: ForgejoPullFilters,
  token: string,
  deps: ForgejoDeps,
): Promise<
  { type: "pull"; pull: PullSnapshot } | ReturnType<typeof pullError>
> {
  const response = await forgejoGet(
    `${api(filters)}/pulls/${filters.pull}`,
    token,
    deps,
    PULL_MISS,
    false,
  );
  if (response.type === "error") return response;
  const row = response.body;
  if (!row || typeof row !== "object") {
    return pullError("Forgejo zwróciło nieczytelny pull request.");
  }
  const item = row as {
    number?: unknown;
    merged?: unknown;
    html_url?: unknown;
  };
  if (item.number !== filters.pull || typeof item.merged !== "boolean") {
    return pullError("Forgejo nie potwierdziło, że to ten pull request.");
  }
  return {
    type: "pull",
    pull: {
      merged: item.merged,
      html: typeof item.html_url === "string" ? item.html_url : "",
    },
  };
}

async function fetchPages(
  base: string,
  token: string,
  deps: ForgejoDeps,
): Promise<
  { type: "rows"; rows: unknown[] } | ReturnType<typeof pullError>
> {
  const rows: unknown[] = [];
  let expected: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await forgejoGet(
      `${base}?limit=${PAGE_LIMIT}&page=${page}`,
      token,
      deps,
      PULL_MISS,
      true,
    );
    if (response.type === "error") return response;
    if (!Array.isArray(response.body)) {
      return pullError("Forgejo nie zwróciło listy.");
    }
    if (response.total !== null) {
      if (expected === null) expected = response.total;
      else if (expected !== response.total) {
        return pullError("Forgejo zmieniło liczbę wpisów w trakcie odczytu.");
      }
    }
    rows.push(...response.body);
    if (
      response.body.length < PAGE_LIMIT ||
      (expected !== null && rows.length >= expected)
    ) break;
    if (page === MAX_PAGES) {
      return pullError("Lista pull requestu jest niepełna.");
    }
  }
  if (expected !== null && rows.length !== expected) {
    return pullError("Forgejo podało inną liczbę wpisów niż zwrócona lista.");
  }
  return { type: "rows", rows };
}

function parseTimeline(
  rows: unknown[],
):
  | { type: "items"; items: PullTimelineItem[] }
  | ReturnType<
    typeof pullError
  > {
  const items: PullTimelineItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      return pullError("Forgejo zwróciło nieczytelny wpis osi czasu.");
    }
    const item = row as Record<string, unknown>;
    if (!Number.isSafeInteger(item.id) || (item.id as number) <= 0) {
      return pullError("Forgejo zwróciło wpis osi czasu bez identyfikatora.");
    }
    if (typeof item.type !== "string" || !item.type) {
      return pullError("Forgejo zwróciło wpis osi czasu bez typu.");
    }
    let reviewId: number | null = null;
    if (item.type === "review") {
      if (
        !Number.isSafeInteger(item.review_id) || (item.review_id as number) <= 0
      ) {
        return pullError("Forgejo zwróciło recenzję bez identyfikatora.");
      }
      reviewId = item.review_id as number;
    }
    items.push({
      id: item.id as number,
      type: item.type,
      author: loginOf(item.user),
      body: typeof item.body === "string" ? item.body : "",
      html: typeof item.html_url === "string" ? item.html_url : "",
      reviewId,
    });
  }
  return { type: "items", items };
}

function parseReviews(
  rows: unknown[],
):
  | { type: "reviews"; reviews: Map<number, string> }
  | ReturnType<
    typeof pullError
  > {
  const reviews = new Map<number, string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      return pullError("Forgejo zwróciło nieczytelną recenzję.");
    }
    const item = row as { id?: unknown; state?: unknown };
    if (!Number.isSafeInteger(item.id) || (item.id as number) <= 0) {
      return pullError("Forgejo zwróciło recenzję bez identyfikatora.");
    }
    if (typeof item.state !== "string" || !item.state) {
      return pullError("Forgejo nie podało stanu recenzji.");
    }
    const id = item.id as number;
    if (reviews.has(id)) {
      return pullError("Forgejo powtórzyło identyfikator recenzji.");
    }
    reviews.set(id, item.state);
  }
  return { type: "reviews", reviews };
}

function loginOf(user: unknown): string {
  if (!user || typeof user !== "object") return "";
  const login = (user as { login?: unknown }).login;
  return typeof login === "string" ? login : "";
}

async function forgejoGet(
  url: string,
  token: string,
  deps: ForgejoDeps,
  miss: string,
  expectTotal: boolean,
): Promise<
  | { type: "error"; message: string; retryAfterMs?: number }
  | { type: "ok"; body: unknown; total: number | null }
> {
  let response: Response;
  try {
    response = await send(deps.fetch, url, {
      headers: {
        authorization: `token ${token}`,
        accept: "application/json",
        "user-agent": "czujka",
      },
    }, SOURCE_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Błąd sieci Forgejo.";
    return {
      type: "error",
      message: `${deps.vault.redact(message)} ${miss}`,
    };
  }
  if (redirected(response.status)) {
    await drain(response);
    return {
      type: "error",
      message: "Forgejo przekierowało żądanie. Token nie został wysłany dalej.",
    };
  }
  if (
    response.status === 404 || response.status === 401 ||
    response.status === 403
  ) {
    await drain(response);
    return {
      type: "error",
      message: response.status === 404
        ? `Forgejo odpowiedziało 404. ${miss}`
        : `Forgejo odmówiło dostępu (${response.status}). ${miss}`,
    };
  }
  if (!response.ok) {
    const retry = retryAfterMs(response, deps.now());
    await drain(response);
    return {
      type: "error",
      message: `Forgejo odpowiedziało ${response.status}. ${miss}`,
      retryAfterMs: retry,
    };
  }
  const total = expectTotal ? totalCount(response) : null;
  if (total === "bad") {
    await drain(response);
    return {
      type: "error",
      message: `Forgejo podało nieczytelną liczbę komentarzy. ${miss}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      type: "error",
      message: `Forgejo zwróciło nieczytelną odpowiedź. ${miss}`,
    };
  }
  return { type: "ok", body, total };
}

function totalCount(response: Response): number | null | "bad" {
  const raw = response.headers.get("x-total-count");
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw)) return "bad";
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return "bad";
  return value;
}
