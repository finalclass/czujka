import assert from "node:assert/strict";
import { iso } from "../clock.ts";
import { Coordinator } from "../coordinator.ts";
import { SecretVault } from "../redact.ts";
import { CachingSecrets } from "../secrets.ts";
import { Store } from "../store.ts";
import { classifyPullActivity } from "./forgejo.ts";
import { LiveSources } from "./live.ts";
import type { ForgejoPullCursor, ForgejoPullFilters } from "../types.ts";
import {
  FakeWake,
  forgejoWatch,
  jsonResponse,
  ManualClock,
  MemorySecrets,
  tempHome,
} from "../testing.ts";

const T0 = 1_700_000_000_000;
const TOKEN = "secret-token-value";

async function rig(envs: Record<string, string>[]) {
  const home = await tempHome();
  const clock = new ManualClock(T0);
  const store = Store.open(home.paths.database);
  const secrets = new MemorySecrets(envs);
  const vault = new SecretVault();
  const wake = new FakeWake();
  const calls: Array<{ url: string; auth: string | null }> = [];
  const route: {
    handle: (url: string, init: RequestInit) => Response | Promise<Response>;
  } = {
    handle: () => jsonResponse({ state: "open", number: 363 }),
  };
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
    });
    assert.equal(init?.redirect, "manual");
    return Promise.resolve(route.handle(String(input), init ?? {}));
  };
  const coordinator = new Coordinator(
    store,
    new LiveSources({
      fetch: fetchImpl,
      secrets,
      vault,
      now: () => clock.current,
    }),
    wake,
    vault,
  );
  return { home, clock, store, secrets, wake, calls, route, coordinator };
}

const PROFILE = {
  FORGEJO_TOKEN: TOKEN,
  FORGEJO_BASE_URL: "https://git.example.com",
};

Deno.test("Forgejo: otwarte nie budzi, interwał wynosi 15 s, zamknięcie jest jedno", async () => {
  const rigged = await rig([PROFILE]);
  let state: "open" | "closed" = "open";
  rigged.route.handle = () => jsonResponse({ state, number: 363 });
  try {
    rigged.store.insertWatch(
      forgejoWatch({ mode: "on", nextCheckAt: iso(T0) }),
    );
    const at = async (ms: number) => {
      rigged.clock.current = ms;
      await rigged.coordinator.poll(ms);
    };
    await at(T0);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);
    assert.equal(rigged.wake.dispatched.length, 0);
    assert.equal(
      rigged.store.getWatch("w_0123456789ab")?.nextCheckAt,
      iso(T0 + 15_000),
    );
    await at(T0 + 14_999);
    assert.equal(rigged.calls.length, 1);
    await at(T0 + 15_000);
    assert.equal(rigged.calls.length, 2);
    state = "closed";
    await at(T0 + 30_000);
    const deliveries = rigged.store.listDeliveries("w_0123456789ab");
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].sourceUrl,
      "https://git.example.com/acme/dg/issues/363",
    );
    assert.equal(deliveries[0].eventKey.endsWith(":close:1"), true);
    assert.match(deliveries[0].text, /Zgłoszenie #363 jest zamknięte/);
    await at(T0 + 45_000);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 1);
    state = "open";
    await at(T0 + 60_000);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 1);
    state = "closed";
    await at(T0 + 75_000);
    const again = rigged.store.listDeliveries("w_0123456789ab");
    assert.deepEqual(again.map((item) => item.eventKey.endsWith(":close:2")), [
      false,
      true,
    ]);
    assert.equal(rigged.wake.dispatched.length, 0);
    await rigged.coordinator.flush(T0 + 75_000);
    await rigged.coordinator.flush(T0 + 75_000);
    assert.equal(rigged.wake.dispatched.length, 2);
    assert.match(rigged.wake.dispatched[0], /approval-required/);
    assert.equal(rigged.wake.dispatched[0].includes("full-access"), false);
    assert.equal(
      rigged.calls.every((call) => call.auth === `token ${TOKEN}`),
      true,
    );
    assert.equal(
      rigged.calls.every((call) =>
        call.url.startsWith("https://git.example.com/api/v1/")
      ),
      true,
    );
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("Forgejo: once reaguje na już zamknięte, on czeka na przejście", async () => {
  const once = await rig([PROFILE]);
  once.route.handle = () => jsonResponse({ state: "closed", number: 363 });
  try {
    once.store.insertWatch(
      forgejoWatch({ mode: "once", nextCheckAt: iso(T0) }),
    );
    await once.coordinator.poll(T0);
    assert.equal(once.store.listDeliveries("w_0123456789ab").length, 1);
    assert.equal(once.store.getWatch("w_0123456789ab")?.phase, "holding");
    await once.coordinator.poll(T0 + 15_000);
    assert.equal(once.calls.length, 1);
  } finally {
    once.store.close();
    await once.home.cleanup();
  }

  const ongoing = await rig([PROFILE]);
  let state: "open" | "closed" = "closed";
  ongoing.route.handle = () => jsonResponse({ state, number: 363 });
  try {
    ongoing.store.insertWatch(
      forgejoWatch({ mode: "on", nextCheckAt: iso(T0) }),
    );
    await ongoing.coordinator.poll(T0);
    assert.equal(ongoing.store.listDeliveries("w_0123456789ab").length, 0);
    const cursor = ongoing.store.getWatch("w_0123456789ab")?.cursor;
    assert.equal(cursor?.kind === "forgejo" && cursor.state, "closed");
    await ongoing.coordinator.poll(T0 + 15_000);
    assert.equal(ongoing.store.listDeliveries("w_0123456789ab").length, 0);
    state = "open";
    await ongoing.coordinator.poll(T0 + 30_000);
    state = "closed";
    await ongoing.coordinator.poll(T0 + 45_000);
    assert.equal(ongoing.store.listDeliveries("w_0123456789ab").length, 1);
  } finally {
    ongoing.store.close();
    await ongoing.home.cleanup();
  }
});

Deno.test("błędy HTTP Forgejo nie zamykają zgłoszenia i nie wysyłają tokenu dalej", async () => {
  const rigged = await rig([PROFILE]);
  let status = 200;
  rigged.route.handle = () => {
    if (status === 302) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    }
    if (status === 404) return new Response("brak", { status: 404 });
    if (status === 429) {
      return new Response("limit", {
        status: 429,
        headers: { "retry-after": "40" },
      });
    }
    if (status === 500) return new Response("{", { status: 200 });
    return jsonResponse({ state: "open", number: 363 });
  };
  try {
    rigged.store.insertWatch(
      forgejoWatch({ mode: "on", nextCheckAt: iso(T0) }),
    );
    await rigged.coordinator.poll(T0);
    assert.equal(
      rigged.store.getWatch("w_0123456789ab")?.cursor?.kind,
      "forgejo",
    );
    status = 404;
    await rigged.coordinator.poll(T0 + 15_000);
    const missed = rigged.store.getWatch("w_0123456789ab");
    assert.match(missed?.lastError ?? "", /404/);
    assert.match(missed?.lastError ?? "", /nie oznacza zamknięcia/);
    assert.equal(
      missed?.cursor?.kind === "forgejo" && missed.cursor.state,
      "open",
    );
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    status = 429;
    await rigged.coordinator.poll(T0 + 30_000);
    assert.equal(
      rigged.store.getWatch("w_0123456789ab")?.nextCheckAt,
      iso(T0 + 30_000 + 40_000),
    );
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    status = 302;
    const before = rigged.calls.length;
    await rigged.coordinator.poll(T0 + 70_000);
    assert.equal(rigged.calls.length, before + 1);
    assert.equal(
      rigged.calls.some((call) => call.url.includes("evil.example")),
      false,
    );
    assert.match(
      rigged.store.getWatch("w_0123456789ab")?.lastError ?? "",
      /przekierowało/,
    );
    assert.equal(
      rigged.store.getWatch("w_0123456789ab")?.cursor?.kind === "forgejo" &&
        rigged.store.getWatch("w_0123456789ab")?.cursor?.kind === "forgejo",
      true,
    );
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("timeout, złe zgłoszenie i obcy origin nie są zamknięciem", async () => {
  const timeout = await rig([PROFILE]);
  timeout.route.handle = () => {
    throw new DOMException("The operation was aborted.", "TimeoutError");
  };
  try {
    timeout.store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await timeout.coordinator.poll(T0);
    const error = timeout.store.getWatch("w_0123456789ab")?.lastError ?? "";
    assert.match(error, /Przekroczono czas oczekiwania/);
    assert.match(error, /nie oznacza zamknięcia/);
    assert.equal(error.includes(TOKEN), false);
    assert.equal(timeout.store.getWatch("w_0123456789ab")?.cursor, null);
  } finally {
    timeout.store.close();
    await timeout.home.cleanup();
  }

  const leaked = await rig([PROFILE]);
  leaked.route.handle = () => {
    throw new Error(`sieć ${TOKEN}`);
  };
  try {
    leaked.store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await leaked.coordinator.poll(T0);
    assert.equal(
      (leaked.store.getWatch("w_0123456789ab")?.lastError ?? "").includes(
        TOKEN,
      ),
      false,
    );
  } finally {
    leaked.store.close();
    await leaked.home.cleanup();
  }

  const wrong = await rig([PROFILE]);
  wrong.route.handle = () => jsonResponse({ state: "closed", number: 1 });
  try {
    wrong.store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await wrong.coordinator.poll(T0);
    assert.equal(wrong.store.listDeliveries("w_0123456789ab").length, 0);
    assert.match(
      wrong.store.getWatch("w_0123456789ab")?.lastError ?? "",
      /inne zgłoszenie/,
    );
  } finally {
    wrong.store.close();
    await wrong.home.cleanup();
  }

  const foreign = await rig([{
    FORGEJO_TOKEN: TOKEN,
    FORGEJO_BASE_URL: "https://other.example",
  }]);
  try {
    foreign.store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await foreign.coordinator.poll(T0);
    assert.equal(foreign.calls.length, 0);
    assert.match(
      foreign.store.getWatch("w_0123456789ab")?.lastError ?? "",
      /innym originem/,
    );
  } finally {
    foreign.store.close();
    await foreign.home.cleanup();
  }

  const api = await rig([{
    FORGEJO_TOKEN: TOKEN,
    FORGEJO_BASE_URL: "https://git.example.com",
    FORGEJO_API_URL: "https://other.example/api/v1",
  }]);
  try {
    api.store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await api.coordinator.poll(T0);
    assert.equal(api.calls.length, 0);
  } finally {
    api.store.close();
    await api.home.cleanup();
  }
});

Deno.test("odrzucony token Forgejo jest odświeżany raz", async () => {
  const rigged = await rig([
    {
      FORGEJO_TOKEN: "stary-token-forgejo",
      FORGEJO_BASE_URL: "https://git.example.com",
    },
    {
      FORGEJO_TOKEN: "nowy-token-forgejo",
      FORGEJO_BASE_URL: "https://git.example.com",
    },
  ]);
  let attempt = 0;
  rigged.route.handle = () => {
    attempt += 1;
    if (attempt === 1) return new Response("no", { status: 401 });
    return jsonResponse({ state: "open", number: 363 });
  };
  try {
    rigged.store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await rigged.coordinator.poll(T0);
    assert.equal(rigged.secrets.loads, 2);
    assert.equal(rigged.secrets.invalidations, 1);
    assert.deepEqual(rigged.calls.map((call) => call.auth), [
      "token stary-token-forgejo",
      "token nowy-token-forgejo",
    ]);
    assert.equal(
      rigged.store.getWatch("w_0123456789ab")?.cursor?.kind,
      "forgejo",
    );
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("cache sekretów nie serwuje tokenu odrzuconego przez Forgejo", async () => {
  const home = await tempHome();
  const clock = new ManualClock(T0);
  const store = Store.open(home.paths.database);
  const inner = new MemorySecrets([
    {
      FORGEJO_TOKEN: "stary-token-forgejo",
      FORGEJO_API_URL: "https://git.example.com/api/v1",
    },
    {
      FORGEJO_TOKEN: "nowy-token-forgejo",
      FORGEJO_API_URL: "https://git.example.com/api/v1",
    },
  ]);
  const vault = new SecretVault();
  let attempt = 0;
  const fetchImpl: typeof fetch = (_input, init) => {
    attempt += 1;
    assert.equal(init?.redirect, "manual");
    if (attempt === 1) {
      return Promise.resolve(new Response("no", { status: 401 }));
    }
    return Promise.resolve(jsonResponse({ state: "closed", number: 363 }));
  };
  const coordinator = new Coordinator(
    store,
    new LiveSources({
      fetch: fetchImpl,
      secrets: new CachingSecrets(inner, clock),
      vault,
      now: () => clock.current,
    }),
    new FakeWake(),
    vault,
  );
  try {
    store.insertWatch(forgejoWatch({ mode: "once", nextCheckAt: iso(T0) }));
    await coordinator.poll(T0);
    assert.equal(inner.loads, 2);
    assert.equal(store.listDeliveries("w_0123456789ab").length, 1);
    assert.equal(store.getWatch("w_0123456789ab")?.phase, "holding");
  } finally {
    store.close();
    await home.cleanup();
  }
});

type CommentRow = {
  id: number;
  body?: string;
  html?: string;
  login?: string;
};

function commentWatch(): ReturnType<typeof forgejoWatch> {
  return forgejoWatch({
    mode: "once",
    phase: "initializing",
    filters: {
      event: "forgejo-issue-commented",
      origin: "https://git.example.com",
      owner: "acme",
      repo: "dg",
      issue: 363,
      profile: "forgejo",
    },
  });
}

function commentList(rows: CommentRow[], total = rows.length): Response {
  return jsonResponse(
    rows.map((row) => ({
      id: row.id,
      body: row.body ?? "treść",
      html_url: row.html ??
        `https://git.example.com/acme/dg/issues/363#issuecomment-${row.id}`,
      user: { login: row.login ?? "ada" },
    })),
    200,
    { "x-total-count": String(total) },
  );
}

const COMMENT_URL =
  "https://git.example.com/api/v1/repos/acme/dg/issues/363/comments";

Deno.test("komentarz Forgejo budzi raz i potem czujka się wyłącza", async () => {
  const rigged = await rig([PROFILE]);
  let rows: CommentRow[] = [
    { id: 2, body: "stary" },
    { id: 5, body: "istniejący" },
  ];
  rigged.route.handle = (url) => {
    assert.equal(url, COMMENT_URL);
    return commentList(rows);
  };
  try {
    rigged.store.insertWatch(commentWatch());
    await rigged.coordinator.poll(T0);
    assert.equal(rigged.store.getWatch("w_0123456789ab")?.phase, "active");
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-comment",
      lastId: 5,
    });
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    rows = [
      { id: 2, body: "stary" },
      { id: 5, body: "to tylko edycja" },
    ];
    await rigged.coordinator.poll(T0 + 15_000);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-comment",
      lastId: 5,
    });

    rows = [
      { id: 9, body: "późniejszy" },
      {
        id: 8,
        body: `wcześniejszy ${TOKEN}`,
        login: "ola",
        html: "https://evil.example/komentarz",
      },
      { id: 5, body: "to tylko edycja" },
    ];
    await rigged.coordinator.poll(T0 + 30_000);
    const deliveries = rigged.store.listDeliveries("w_0123456789ab");
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].eventKey,
      "forgejo-comment:https://git.example.com:acme/dg#363:8",
    );
    assert.equal(
      deliveries[0].sourceUrl,
      "https://git.example.com/acme/dg/issues/363#issuecomment-8",
    );
    assert.match(deliveries[0].text, /forgejo-issue-commented/);
    assert.match(deliveries[0].text, /od ola/);
    assert.match(deliveries[0].text, /wcześniejszy \[sekret\]/);
    assert.equal(deliveries[0].text.includes(TOKEN), false);
    assert.equal(deliveries[0].text.includes("późniejszy"), false);
    assert.equal(deliveries[0].sourceUrl?.includes("evil.example"), false);
    assert.equal(rigged.store.getWatch("w_0123456789ab")?.phase, "holding");
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-comment",
      lastId: 8,
    });

    const seen = rigged.calls.length;
    rows = [{ id: 8 }, { id: 9 }, { id: 11, body: "jeszcze jeden" }];
    await rigged.coordinator.poll(T0 + 45_000);
    assert.equal(rigged.calls.length, seen);
    await rigged.coordinator.flush(T0 + 45_000);
    assert.equal(rigged.wake.dispatched.length, 1);
    assert.equal(rigged.store.getWatch("w_0123456789ab")?.phase, "completed");
    await rigged.coordinator.poll(T0 + 60_000);
    assert.equal(rigged.calls.length, seen);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 1);
    assert.equal(
      rigged.calls.every((call) => call.auth === `token ${TOKEN}`),
      true,
    );
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("zniknięcie wysokiego komentarza nie wczytuje starszych jako nowych", async () => {
  const rigged = await rig([PROFILE]);
  let rows: CommentRow[] = [{ id: 1 }, { id: 10 }];
  rigged.route.handle = () => commentList(rows);
  try {
    rigged.store.insertWatch(commentWatch());
    await rigged.coordinator.poll(T0);
    rows = [{ id: 1 }, { id: 2 }];
    await rigged.coordinator.poll(T0 + 15_000);
    const watch = rigged.store.getWatch("w_0123456789ab");
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);
    assert.deepEqual(watch?.cursor, { kind: "forgejo-comment", lastId: 10 });
    assert.match(watch?.continuity ?? "", /nie jest już na liście/);
    assert.equal(watch?.phase, "active");
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("błędy listy komentarzy nie są nowym komentarzem", async () => {
  const rigged = await rig([PROFILE]);
  let response: Response = new Response("brak", { status: 404 });
  rigged.route.handle = (url) => {
    assert.equal(url, COMMENT_URL);
    return response;
  };
  try {
    rigged.store.insertWatch(commentWatch());
    await rigged.coordinator.poll(T0);
    const missing = rigged.store.getWatch("w_0123456789ab");
    assert.equal(missing?.cursor, null);
    assert.equal(missing?.phase, "initializing");
    assert.match(missing?.lastError ?? "", /404/);
    assert.match(missing?.lastError ?? "", /nowego komentarza/);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    response = commentList([{ id: 4 }]);
    await rigged.coordinator.poll(T0 + 15_000);
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-comment",
      lastId: 4,
    });

    response = commentList([{ id: 4 }, { id: 6 }], 9);
    await rigged.coordinator.poll(T0 + 30_000);
    const mismatch = rigged.store.getWatch("w_0123456789ab");
    assert.match(mismatch?.lastError ?? "", /inną liczbę komentarzy/);
    assert.deepEqual(mismatch?.cursor, { kind: "forgejo-comment", lastId: 4 });
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    response = new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/steal" },
    });
    const before = rigged.calls.length;
    await rigged.coordinator.poll(T0 + 45_000);
    assert.equal(rigged.calls.length, before + 1);
    assert.equal(
      rigged.calls.some((call) => call.url.includes("evil.example")),
      false,
    );
    assert.match(
      rigged.store.getWatch("w_0123456789ab")?.lastError ?? "",
      /przekierowało/,
    );
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-comment",
      lastId: 4,
    });
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

const PULL_FILTERS: ForgejoPullFilters = {
  event: "forgejo-pull-activity",
  origin: "https://git.example.com",
  owner: "acme",
  repo: "dg",
  pull: 12,
  profile: "forgejo",
};

type TimelineInput = {
  id: number;
  type: string;
  author?: string;
  body?: string;
  html?: string;
  reviewId?: number | null;
};

function pullCursor(
  lastId: number,
  merged = false,
  mergePendingClose = false,
): ForgejoPullCursor {
  return { kind: "forgejo-pull", lastId, mergePendingClose, merged };
}

function classifyPull(
  cursor: ForgejoPullCursor | null,
  items: TimelineInput[],
  reviews: ReadonlyMap<number, string>,
  merged: boolean,
) {
  const vault = new SecretVault();
  vault.note(TOKEN);
  return classifyPullActivity(
    PULL_FILTERS,
    cursor,
    items.map((item) => ({
      id: item.id,
      type: item.type,
      author: item.author ?? "ada",
      body: item.body ?? "",
      html: item.html ?? "",
      reviewId: item.reviewId ?? null,
    })),
    reviews,
    {
      merged,
      html: "https://git.example.com/acme/dg/pulls/12",
    },
    vault,
  );
}

function pullTexts(
  observation: ReturnType<typeof classifyPull>,
): string[] {
  if (observation.type !== "messages") return [];
  return observation.messages.map((message) => message.summary);
}

Deno.test("oś czasu pull requestu rozróżnia akceptację, odrzucenie, scalenie i komentarz", () => {
  const baseline = classifyPull(
    null,
    [
      { id: 1, type: "comment", body: "stary" },
      { id: 2, type: "review", reviewId: 20 },
      { id: 3, type: "merge_pull" },
      { id: 4, type: "close" },
    ],
    new Map([[20, "APPROVED"]]),
    true,
  );
  assert.equal(baseline.type, "baseline");
  if (baseline.type !== "baseline") return;
  assert.deepEqual(baseline.cursor, pullCursor(4, true, false));

  const reviews = new Map([
    [20, "APPROVED"],
    [60, "REQUEST_CHANGES"],
    [70, "APPROVED"],
    [80, "COMMENT"],
    [90, "PENDING"],
  ]);
  const next = classifyPull(
    pullCursor(4, true),
    [
      { id: 1, type: "comment", body: "stary" },
      { id: 2, type: "review", reviewId: 20 },
      { id: 3, type: "merge_pull" },
      { id: 4, type: "close" },
      { id: 5, type: "comment", body: `nowy ${TOKEN}`, author: "ola" },
      { id: 6, type: "review", reviewId: 60, body: "popraw to" },
      { id: 7, type: "review", reviewId: 70, body: "dobrze" },
      { id: 8, type: "review", reviewId: 80, body: "pytanie" },
      { id: 9, type: "code", body: "linia diffu" },
      { id: 10, type: "pull_push" },
      { id: 11, type: "review", reviewId: 90 },
    ],
    reviews,
    true,
  );
  assert.equal(next.type, "messages");
  if (next.type !== "messages") return;
  assert.deepEqual(pullTexts(next), [
    "Nowy komentarz pod pull requestem #12 od ola. Treść: nowy [sekret].",
    "Pull request #12 został odrzucony w recenzji przez ada. Treść: popraw to.",
    "Pull request #12 został zaakceptowany przez ada. Treść: dobrze.",
    "Nowy komentarz pod pull requestem #12 od ada. Treść: pytanie.",
  ]);
  assert.equal(
    next.messages.some((message) => message.summary.includes(TOKEN)),
    false,
  );
  assert.deepEqual(next.cursor, pullCursor(11, true, false));
  assert.equal(
    next.messages[0].url,
    "https://git.example.com/acme/dg/pulls/12#issuecomment-5",
  );

  const merged = classifyPull(
    pullCursor(1),
    [
      { id: 1, type: "comment" },
      { id: 2, type: "merge_pull", author: "ela" },
      { id: 3, type: "close", author: "ela" },
    ],
    new Map(),
    true,
  );
  assert.deepEqual(pullTexts(merged), [
    "Pull request #12 został scalony przez ela.",
  ]);

  const rejected = classifyPull(
    pullCursor(1),
    [
      { id: 1, type: "comment" },
      { id: 2, type: "close", author: "ela" },
    ],
    new Map(),
    false,
  );
  assert.deepEqual(pullTexts(rejected), [
    "Pull request #12 został zamknięty bez scalenia przez ela.",
  ]);

  const again = classifyPull(
    pullCursor(1),
    [
      { id: 2, type: "close" },
      { id: 3, type: "reopen" },
      { id: 4, type: "merge_pull" },
      { id: 5, type: "close" },
    ],
    new Map(),
    true,
  );
  assert.deepEqual(pullTexts(again).map((text) => text.split(".")[0]), [
    "Pull request #12 został zamknięty bez scalenia przez ada",
    "Pull request #12 został scalony przez ada",
  ]);

  const foreign = classifyPull(
    pullCursor(4, true),
    [
      {
        id: 5,
        type: "comment",
        html: "https://evil.example/pulls/12#issuecomment-5",
      },
    ],
    new Map(),
    true,
  );
  if (foreign.type !== "messages") return;
  assert.equal(
    foreign.messages[0].url,
    "https://git.example.com/acme/dg/pulls/12#issuecomment-5",
  );

  const missing = classifyPull(
    pullCursor(4),
    [
      { id: 5, type: "review", reviewId: 5 },
    ],
    new Map(),
    false,
  );
  assert.equal(missing.type, "error");
  if (missing.type !== "error") return;
  assert.match(missing.message, /stanu recenzji/);
  assert.match(missing.message, /aktywności pull requestu/);

  const shrunk = classifyPull(
    pullCursor(8),
    [
      { id: 1, type: "comment" },
    ],
    new Map(),
    false,
  );
  assert.equal(shrunk.type, "messages");
  if (shrunk.type !== "messages") return;
  assert.equal(shrunk.messages.length, 0);
  assert.deepEqual(shrunk.cursor, pullCursor(8));
  assert.match(shrunk.note ?? "", /nie jest już na liście/);
});

function pullWatch(mode: "once" | "on" = "on") {
  return forgejoWatch({
    mode,
    phase: "initializing",
    filters: PULL_FILTERS,
  });
}

type PullTimelineRow = {
  id: number;
  type: string;
  body?: string;
  login?: string;
  reviewId?: number;
};

function pullFixture(
  rows: PullTimelineRow[],
  reviews: Array<{
    id: number;
    state: string;
  }>,
  merged: boolean,
) {
  return (url: string): Response => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v1/repos/acme/dg/pulls/12") {
      return jsonResponse({
        number: 12,
        merged,
        html_url: "https://git.example.com/acme/dg/pulls/12",
      });
    }
    const limit = Number(parsed.searchParams.get("limit"));
    const page = Number(parsed.searchParams.get("page"));
    const source = parsed.pathname.endsWith("/timeline")
      ? rows
      : parsed.pathname.endsWith("/reviews")
      ? reviews
      : null;
    if (!source || limit !== 50 || !Number.isInteger(page) || page < 1) {
      return new Response("zly adres", { status: 500 });
    }
    const slice = source.slice((page - 1) * limit, page * limit);
    const body = parsed.pathname.endsWith("/timeline")
      ? (slice as PullTimelineRow[]).map((row) => ({
        id: row.id,
        type: row.type,
        body: row.body ?? "",
        html_url: "",
        user: { login: row.login ?? "ada" },
        review_id: row.reviewId ?? 0,
      }))
      : slice;
    return jsonResponse(body, 200, { "x-total-count": String(source.length) });
  };
}

Deno.test("pull request budzi na każde nowe zdarzenie i nie wznawia historii", async () => {
  const rigged = await rig([PROFILE]);
  const history: PullTimelineRow[] = [
    { id: 1, type: "comment", body: "było" },
    { id: 2, type: "review", reviewId: 2, body: "wcześniejsza akceptacja" },
  ];
  let rows = history;
  let reviews = [{ id: 2, state: "APPROVED" }];
  let merged = false;
  rigged.route.handle = (url) => pullFixture(rows, reviews, merged)(url);
  try {
    rigged.store.insertWatch(pullWatch("on"));
    await rigged.coordinator.poll(T0);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-pull",
      lastId: 2,
      mergePendingClose: false,
      merged: false,
    });
    assert.equal(
      rigged.calls.some((call) => call.url.includes("/reviews")),
      false,
    );

    rows = [
      ...history,
      { id: 3, type: "comment", body: "komentarz" },
      { id: 4, type: "review", reviewId: 4, body: "odrzucam" },
      { id: 5, type: "code", body: "linia" },
      { id: 6, type: "pull_push" },
    ];
    reviews = [
      { id: 2, state: "APPROVED" },
      { id: 4, state: "REQUEST_CHANGES" },
    ];
    await rigged.coordinator.poll(T0 + 15_000);
    const first = rigged.store.listDeliveries("w_0123456789ab");
    assert.deepEqual(first.map((item) => item.summary), [
      "Nowy komentarz pod pull requestem #12 od ada. Treść: komentarz.",
      "Pull request #12 został odrzucony w recenzji przez ada. Treść: odrzucam.",
    ]);
    assert.equal(rigged.store.getWatch("w_0123456789ab")?.phase, "active");

    rows = [
      ...rows,
      { id: 7, type: "review", reviewId: 7, body: "akceptuję" },
    ];
    reviews = [...reviews, { id: 7, state: "APPROVED" }];
    await rigged.coordinator.poll(T0 + 30_000);
    merged = true;
    rows = [
      ...rows,
      { id: 8, type: "merge_pull", login: "ela" },
      { id: 9, type: "close", login: "ela" },
    ];
    await rigged.coordinator.poll(T0 + 45_000);
    const all = rigged.store.listDeliveries("w_0123456789ab");
    assert.deepEqual(all.map((item) => item.summary), [
      "Nowy komentarz pod pull requestem #12 od ada. Treść: komentarz.",
      "Pull request #12 został odrzucony w recenzji przez ada. Treść: odrzucam.",
      "Pull request #12 został zaakceptowany przez ada. Treść: akceptuję.",
      "Pull request #12 został scalony przez ela.",
    ]);
    assert.equal(all[3].eventKey.endsWith(":merged:8"), true);
    assert.match(all[0].text, /forgejo-pull-activity/);
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-pull",
      lastId: 9,
      mergePendingClose: false,
      merged: true,
    });
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("jednorazowa czujka pull requestu bierze najwcześniejsze zdarzenie", async () => {
  const rigged = await rig([PROFILE]);
  let rows: PullTimelineRow[] = [{ id: 1, type: "comment", body: "stary" }];
  rigged.route.handle = (url) => pullFixture(rows, [], false)(url);
  try {
    rigged.store.insertWatch(pullWatch("once"));
    await rigged.coordinator.poll(T0);
    rows = [
      { id: 1, type: "comment", body: "stary" },
      { id: 2, type: "comment", body: "pierwszy" },
      { id: 3, type: "comment", body: "drugi" },
    ];
    await rigged.coordinator.poll(T0 + 15_000);
    const deliveries = rigged.store.listDeliveries("w_0123456789ab");
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].summary, /pierwszy/);
    assert.equal(deliveries[0].summary.includes("drugi"), false);
    assert.equal(rigged.store.getWatch("w_0123456789ab")?.phase, "holding");
    const seen = rigged.calls.length;
    await rigged.coordinator.poll(T0 + 30_000);
    assert.equal(rigged.calls.length, seen);
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});

Deno.test("niepełny pull request i długa oś czasu nie są aktywnością", async () => {
  const rigged = await rig([PROFILE]);
  let status = 404;
  const longRows: PullTimelineRow[] = Array.from(
    { length: 51 },
    (_, index) => ({
      id: index + 1,
      type: "pull_push",
    }),
  );
  rigged.route.handle = (url) => {
    if (status !== 200) return new Response("brak", { status });
    return pullFixture(longRows, [], false)(url);
  };
  try {
    rigged.store.insertWatch(pullWatch());
    await rigged.coordinator.poll(T0);
    const missing = rigged.store.getWatch("w_0123456789ab");
    assert.equal(missing?.cursor, null);
    assert.match(missing?.lastError ?? "", /404/);
    assert.match(missing?.lastError ?? "", /aktywności pull requestu/);
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    status = 200;
    await rigged.coordinator.poll(T0 + 15_000);
    assert.equal(
      rigged.calls.filter((call) => call.url.includes("/timeline")).length,
      2,
    );
    assert.deepEqual(rigged.store.getWatch("w_0123456789ab")?.cursor, {
      kind: "forgejo-pull",
      lastId: 51,
      mergePendingClose: false,
      merged: false,
    });
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);

    longRows.push({ id: 52, type: "review", reviewId: 52, body: "bez stanu" });
    await rigged.coordinator.poll(T0 + 30_000);
    const stuck = rigged.store.getWatch("w_0123456789ab");
    assert.match(stuck?.lastError ?? "", /stanu recenzji/);
    assert.equal(
      (stuck?.cursor && "lastId" in stuck.cursor) ? stuck.cursor.lastId : 0,
      51,
    );
    assert.equal(rigged.store.listDeliveries("w_0123456789ab").length, 0);
  } finally {
    rigged.store.close();
    await rigged.home.cleanup();
  }
});
