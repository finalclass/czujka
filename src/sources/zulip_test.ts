import assert from "node:assert/strict";
import { iso } from "../clock.ts";
import { Coordinator } from "../coordinator.ts";
import { SecretVault } from "../redact.ts";
import { CachingSecrets } from "../secrets.ts";
import { Store } from "../store.ts";
import { observeZulip } from "./zulip.ts";
import { LiveSources } from "./live.ts";
import {
  FakeWake,
  jsonResponse,
  ManualClock,
  MemorySecrets,
  tempHome,
  zulipWatch,
} from "../testing.ts";
import type { ZulipCursor, ZulipFilters } from "../types.ts";

const T0 = 1_700_000_000_000;
const KEY = "zulip-secret-key";
const SITE = "https://zulip.example.com";

function envOf(): Record<string, string> {
  return {
    ZULIP_SITE: SITE,
    ZULIP_EMAIL: "bot@example.com",
    ZULIP_API_KEY: KEY,
  };
}

function message(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    stream_id: 7,
    display_recipient: "development",
    subject: "release",
    sender_email: "ada@example.com",
    type: "stream",
    content: "sekret treści której nie zapisujemy",
    ...extra,
  };
}

function filters(extra: Partial<ZulipFilters> = {}): ZulipFilters {
  return {
    event: "zulip-message-received",
    profile: "zulip",
    secretProfile: "zulip",
    stream: "development",
    topic: "release",
    ...extra,
  };
}

function server(onMessage: (url: URL) => Record<string, unknown>, streams?: {
  subscriptions: Array<{ name: string; stream_id: number }>;
  all: Array<{ name: string; stream_id: number }>;
}) {
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(url.username, "");
    assert.equal(url.toString().includes(KEY), false);
    if (url.pathname === "/api/v1/users/me/subscriptions") {
      return Promise.resolve(jsonResponse({
        subscriptions: streams?.subscriptions ??
          [{ name: "development", stream_id: 7 }],
      }));
    }
    if (url.pathname === "/api/v1/streams") {
      return Promise.resolve(jsonResponse({
        streams: streams?.all ?? [{ name: "development", stream_id: 7 }],
      }));
    }
    if (url.pathname === "/api/v1/messages") {
      return Promise.resolve(jsonResponse(onMessage(url)));
    }
    return Promise.resolve(jsonResponse({ result: "error" }, 404));
  };
  return { calls, fetchImpl };
}

Deno.test("Zulip: punkt startowy nie wczytuje historii kanału", async () => {
  const { calls, fetchImpl } = server((url) => {
    assert.equal(url.searchParams.get("anchor"), "newest");
    assert.equal(url.searchParams.get("num_before"), "1");
    assert.match(url.searchParams.get("narrow") ?? "", /"operator":"channel"/);
    assert.match(url.searchParams.get("narrow") ?? "", /"operand":7/);
    assert.match(url.searchParams.get("narrow") ?? "", /"operator":"topic"/);
    assert.match(url.searchParams.get("narrow") ?? "", /"operand":"release"/);
    return { messages: [message(40)], found_newest: true };
  });
  const result = await observeZulip(filters(), null, {
    fetch: fetchImpl,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(result.type, "baseline");
  if (result.type !== "baseline" || result.cursor.kind !== "zulip") return;
  assert.equal(result.cursor.lastId, 40);
  assert.equal(result.cursor.streamId, 7);
  assert.equal(JSON.stringify(result).includes("sekret treści"), false);
  assert.equal(
    calls.some((url) => url.searchParams.get("anchor") === "newest"),
    true,
  );
});

Deno.test("Zulip: kilka stron, edycja nie jest nową wiadomością, luka historii jest jawna", async () => {
  const all = [11, 12, 13, 14, 15].map((id) => message(id));
  const paged = server((url) => {
    const anchor = Number(url.searchParams.get("anchor"));
    const limit = Number(url.searchParams.get("num_after"));
    const rest = all.filter((item) => item.id > anchor);
    const page = rest.slice(0, limit);
    return { messages: page, found_newest: page.length === rest.length };
  });
  const cursor: ZulipCursor = {
    kind: "zulip",
    site: SITE,
    streamId: 7,
    lastId: 10,
  };
  const pages = await observeZulip(filters(), cursor, {
    fetch: paged.fetchImpl,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
    pageLimit: 2,
  });
  assert.equal(pages.type, "messages");
  if (pages.type !== "messages") return;
  assert.deepEqual(pages.messages.map((item) => item.order), [
    11,
    12,
    13,
    14,
    15,
  ]);
  const anchors = paged.calls.filter((url) =>
    url.pathname === "/api/v1/messages"
  ).map((url) => url.searchParams.get("anchor"));
  assert.deepEqual(anchors, ["10", "12", "14"]);

  const edited = server(() => ({
    messages: [message(10, { content: "edycja sekret treści" }), message(11)],
    found_newest: true,
  }));
  const fresh = await observeZulip(filters(), cursor, {
    fetch: edited.fetchImpl,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(fresh.type, "messages");
  if (fresh.type !== "messages") return;
  assert.deepEqual(fresh.messages.map((item) => item.order), [11]);
  assert.equal(JSON.stringify(fresh).includes("sekret treści"), false);

  const gap = server(() => ({
    messages: [message(50)],
    found_newest: true,
    history_limited: true,
  }));
  const limited = await observeZulip(filters(), cursor, {
    fetch: gap.fetchImpl,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(limited.type, "messages");
  if (limited.type !== "messages") return;
  assert.deepEqual(limited.messages.map((item) => item.order), [50]);
  assert.match(limited.note ?? "", /ograniczył dostępną historię/);
  assert.equal(limited.messages.some((item) => item.order === 11), false);
});

Deno.test("Zulip: zły kanał, przekierowanie i odrzucony klucz", async () => {
  const missing = server(() => ({ messages: [] }), {
    subscriptions: [],
    all: [],
  });
  const absent = await observeZulip(filters({ stream: "Development" }), null, {
    fetch: missing.fetchImpl,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(absent.type, "error");
  if (absent.type === "error") {
    assert.match(absent.message, /Nie znaleziono kanału/);
  }

  const mixed = server(() => ({ messages: [] }), {
    subscriptions: [{ name: "development", stream_id: 1 }],
    all: [{ name: "development", stream_id: 2 }],
  });
  const ambiguous = await observeZulip(filters(), null, {
    fetch: mixed.fetchImpl,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(ambiguous.type, "error");
  if (ambiguous.type === "error") {
    assert.match(ambiguous.message, /niejednoznaczna/);
  }

  let redirected = 0;
  const redirectFetch: typeof fetch = (input, init) => {
    redirected += 1;
    assert.equal(init?.redirect, "manual");
    assert.equal(String(input).includes(KEY), false);
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/x" },
      }),
    );
  };
  const moved = await observeZulip(filters(), null, {
    fetch: redirectFetch,
    secrets: new MemorySecrets([envOf()]),
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(redirected, 1);
  assert.equal(moved.type, "error");
  if (moved.type === "error") {
    assert.match(moved.message, /przekierowało/);
    assert.equal(moved.message.includes(KEY), false);
  }

  const inner = new MemorySecrets([envOf()]);
  const clock = new ManualClock(0);
  const cache = new CachingSecrets(inner, clock);
  const deniedFetch: typeof fetch = (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return Promise.resolve(jsonResponse({ result: "error" }, 401));
  };
  const denied = await observeZulip(filters(), null, {
    fetch: deniedFetch,
    secrets: cache,
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(denied.type, "error");
  if (denied.type === "error") {
    assert.match(denied.message, /uwierzytelnienie/);
    assert.equal(denied.message.includes(KEY), false);
  }
  await observeZulip(filters(), null, {
    fetch: deniedFetch,
    secrets: cache,
    vault: new SecretVault(),
    now: () => T0,
  });
  assert.equal(inner.loads, 2);
});

Deno.test("Zulip przez magazyn: baza, once, on, przestój i zmiana serwera", async () => {
  const home = await tempHome();
  const clock = new ManualClock(T0);
  const store = Store.open(home.paths.database);
  const published = [11, 12, 13];
  const { fetchImpl } = server((url) => {
    const anchor = url.searchParams.get("anchor");
    if (anchor === "newest") {
      return { messages: [message(10)], found_newest: true };
    }
    const start = Number(anchor);
    const rows = published.filter((id) => id > start).map((id) =>
      message(id, {
        type: id === 12 ? "private" : "stream",
        content: "sekret treści",
      })
    );
    return {
      messages: [
        message(start, { content: "edycja sekret treści" }),
        ...rows,
      ],
      found_newest: true,
    };
  });
  const vault = new SecretVault();
  const wake = new FakeWake();
  const coordinator = new Coordinator(
    store,
    new LiveSources({
      fetch: fetchImpl,
      secrets: new MemorySecrets([envOf()]),
      vault,
      now: () => clock.current,
    }),
    wake,
    vault,
  );
  try {
    store.insertWatch(zulipWatch({
      mode: "once",
      nextCheckAt: iso(T0),
      filters: filters({ topic: null }),
    }));
    await coordinator.poll(T0);
    assert.equal(store.listDeliveries("w_0123456789ab").length, 0);
    assert.equal(store.getWatch("w_0123456789ab")?.phase, "active");
    assert.equal(
      store.getWatch("w_0123456789ab")?.cursor?.kind === "zulip" &&
        store.getWatch("w_0123456789ab")?.cursor &&
        (store.getWatch("w_0123456789ab")!.cursor as ZulipCursor).lastId,
      10,
    );
    published.push(14);
    await coordinator.poll(T0 + 15_000);
    const once = store.listDeliveries("w_0123456789ab");
    assert.equal(once.length, 1);
    assert.match(once[0].eventKey, /:11$/);
    assert.equal(once[0].text.includes("sekret treści"), false);
    assert.equal(store.getWatch("w_0123456789ab")?.phase, "holding");
  } finally {
    store.close();
    await home.cleanup();
  }

  const second = await tempHome();
  const secondStore = Store.open(second.paths.database);
  const clock2 = new ManualClock(T0);
  const arrived = [11, 12];
  const restarted = server((url) => {
    const anchor = url.searchParams.get("anchor");
    if (anchor === "newest") {
      return { messages: [message(10)], found_newest: true };
    }
    const start = Number(anchor);
    return {
      messages: arrived.filter((id) => id > start).map((id) => message(id)),
      found_newest: true,
    };
  });
  const vault2 = new SecretVault();
  let resumed = new Coordinator(
    secondStore,
    new LiveSources({
      fetch: restarted.fetchImpl,
      secrets: new MemorySecrets([envOf()]),
      vault: vault2,
      now: () => clock2.current,
    }),
    new FakeWake(),
    vault2,
  );
  try {
    secondStore.insertWatch(
      zulipWatch({
        mode: "on",
        nextCheckAt: iso(T0),
        filters: filters({ topic: null }),
      }),
    );
    await resumed.poll(T0);
    secondStore.close();
    const reopened = Store.open(second.paths.database);
    const wake = new FakeWake();
    resumed = new Coordinator(
      reopened,
      new LiveSources({
        fetch: restarted.fetchImpl,
        secrets: new MemorySecrets([envOf()]),
        vault: new SecretVault(),
        now: () => clock2.current,
      }),
      wake,
      new SecretVault(),
    );
    arrived.push(13, 14);
    await resumed.poll(T0 + 15_000);
    const keys = reopened.listDeliveries("w_0123456789ab").map((item) =>
      item.eventKey
    );
    assert.deepEqual(
      keys,
      [11, 12, 13, 14].map((id) => `zulip:${SITE}:7:${id}`),
    );
    const newestAfterRestart = restarted.calls.filter((url) =>
      url.searchParams.get("anchor") === "newest"
    );
    assert.equal(newestAfterRestart.length, 1);
    await resumed.flush(T0 + 15_000);
    await resumed.flush(T0 + 15_000);
    await resumed.flush(T0 + 15_000);
    await resumed.flush(T0 + 15_000);
    assert.equal(wake.dispatched.length, 4);
    await resumed.poll(T0 + 30_000);
    assert.equal(reopened.listDeliveries("w_0123456789ab").length, 4);

    const moved = zulipWatch({
      id: "w_abcdefabcdef",
      phase: "active",
      mode: "on",
      nextCheckAt: iso(T0 + 45_000),
      cursor: {
        kind: "zulip",
        site: "https://old.example",
        streamId: 7,
        lastId: 3,
      },
      filters: filters({ topic: null }),
    });
    reopened.insertWatch(moved);
    await resumed.poll(T0 + 45_000);
    const reset = reopened.getWatch("w_abcdefabcdef");
    assert.match(reset?.continuity ?? "", /inny serwer/);
    assert.equal(reopened.listDeliveries("w_abcdefabcdef").length, 0);
    assert.equal(reset?.cursor?.kind === "zulip" && reset.cursor.site, SITE);
    reopened.close();
  } finally {
    await second.cleanup();
  }
});
