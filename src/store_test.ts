import assert from "node:assert/strict";
import { iso } from "./clock.ts";
import { Store } from "./store.ts";
import { forgejoWatch, tempHome, zohoWatch } from "./testing.ts";
import type { WatchUpdate } from "./types.ts";

function update(partial: Partial<WatchUpdate> = {}): WatchUpdate {
  return {
    phase: "active",
    cursor: { kind: "forgejo", state: "closed", transition: 1 },
    continuity: null,
    lastError: null,
    failures: 0,
    nextCheckAt: iso(15_000),
    lastCheckAt: iso(1_000),
    events: [{
      key: "evt-1",
      summary: "zamknięte",
      url: "https://git.example.com/acme/dg/issues/363",
    }],
    ...partial,
  };
}

Deno.test("magazyn przeżywa restart i nie dubluje zdarzenia", async () => {
  const home = await tempHome();
  const first = Store.open(home.paths.database);
  try {
    const watch = forgejoWatch({ id: "w_0123456789ab", nextCheckAt: iso(0) });
    first.insertWatch(watch);
    const mail = zohoWatch({ id: "w_abcdefabcdef", nextCheckAt: iso(0) });
    first.insertWatch(mail);
    first.apply("w_0123456789ab", update(), [{
      key: "evt-1",
      summary: "zamknięte",
      url: "https://git.example.com/acme/dg/issues/363",
      text: "treść",
    }]);
    first.apply(
      "w_0123456789ab",
      update({
        cursor: { kind: "forgejo", state: "closed", transition: 2 },
        events: [{ key: "evt-1", summary: "ponownie", url: null }],
      }),
      [{ key: "evt-1", summary: "ponownie", url: null, text: "inna" }],
    );
    assert.equal(first.listDeliveries("w_0123456789ab").length, 1);
    assert.equal(first.listDeliveries("w_0123456789ab")[0].text, "treść");
    assert.equal(first.getWatch("w_0123456789ab")?.cursor?.kind, "forgejo");
  } finally {
    first.close();
  }

  const second = Store.open(home.paths.database);
  try {
    assert.equal(second.listWatches().length, 2);
    const watch = second.getWatch("w_0123456789ab");
    assert.equal(watch?.phase, "active");
    assert.equal(watch?.wakeTarget, "thread-1");
    const delivery = second.listDeliveries("w_0123456789ab")[0];
    assert.equal(delivery.status, "pending");
    assert.match(delivery.commandId, /^[0-9a-f-]{36}$/);
    assert.equal(
      second.due(0, 10).map((item) => item.id).includes("w_abcdefabcdef"),
      true,
    );
    assert.equal(second.due(0, 1).length, 1);
  } finally {
    second.close();
    await home.cleanup();
  }
});

Deno.test("transakcja cofa częściowy zapis, a once i remove rozróżniają dostawy", async () => {
  const home = await tempHome();
  const store = Store.open(home.paths.database);
  try {
    store.insertWatch(forgejoWatch({ mode: "once" }));
    assert.throws(() =>
      store.apply(
        "w_0123456789ab",
        update({
          events: [
            { key: "a", summary: "a", url: null },
            { key: "b", summary: "b", url: null },
          ],
        }),
        [
          { key: "a", summary: "a", url: null, text: "a" },
          { key: "z", summary: "z", url: null, text: "z" },
        ],
      )
    );
    assert.equal(store.getWatch("w_0123456789ab")?.cursor, null);
    assert.equal(store.listDeliveries("w_0123456789ab").length, 0);

    store.apply(
      "w_0123456789ab",
      update({
        phase: "holding",
        events: [
          { key: "a", summary: "a", url: null },
          { key: "b", summary: "b", url: null },
        ],
      }),
      [
        { key: "a", summary: "a", url: null, text: "a" },
        { key: "b", summary: "b", url: null, text: "b" },
      ],
    );
    const [first, second] = store.listDeliveries("w_0123456789ab");
    store.apply(
      "w_0123456789ab",
      update({
        phase: "active",
        events: [{ key: "c", summary: "c", url: null }],
      }),
      [{ key: "c", summary: "c", url: null, text: "c" }],
    );
    assert.equal(
      store.listDeliveries("w_0123456789ab").some((item) =>
        item.eventKey === "c"
      ),
      false,
    );
    assert.equal(store.heads(2_000, 10).length, 1);
    assert.equal(store.heads(2_000, 10)[0].id, first.id);
    store.settle({
      id: first.id,
      status: "accepted",
      lastError: null,
      attempts: 1,
      nextAttemptAt: null,
      acceptedAt: iso(2_000),
      completeWatchId: "w_0123456789ab",
      now: iso(2_000),
    });
    assert.equal(store.getWatch("w_0123456789ab")?.phase, "completed");
    assert.equal(store.getDelivery(second.id)?.status, "cancelled");
    assert.equal(store.getDelivery(first.id)?.status, "accepted");
    store.apply(
      "w_0123456789ab",
      update({
        phase: "active",
        events: [{ key: "c", summary: "c", url: null }],
      }),
      [{ key: "c", summary: "c", url: null, text: "c" }],
    );
    assert.equal(
      store.listDeliveries("w_0123456789ab").some((item) =>
        item.eventKey === "c"
      ),
      false,
    );

    const removed = store.remove("w_0123456789ab", iso(3_000));
    assert.equal(removed, 0);
    assert.equal(store.getDelivery(first.id)?.status, "accepted");
    assert.equal(store.getWatch("w_0123456789ab")?.phase, "removed");
    assert.equal(store.due(10_000, 10).length, 0);
  } finally {
    store.close();
    await home.cleanup();
  }
});

Deno.test("remove anuluje niewysłane i zostawia przyjętą", async () => {
  const home = await tempHome();
  const store = Store.open(home.paths.database);
  try {
    store.insertWatch(forgejoWatch({ mode: "on" }));
    store.apply(
      "w_0123456789ab",
      update({
        events: [
          { key: "a", summary: "a", url: null },
          { key: "b", summary: "b", url: null },
        ],
      }),
      [
        { key: "a", summary: "a", url: null, text: "a" },
        { key: "b", summary: "b", url: null, text: "b" },
      ],
    );
    const [accepted, pending] = store.listDeliveries("w_0123456789ab");
    store.settle({
      id: accepted.id,
      status: "accepted",
      lastError: null,
      attempts: 1,
      nextAttemptAt: null,
      acceptedAt: iso(1_000),
      completeWatchId: null,
      now: iso(1_000),
    });
    const cancelled = store.remove("w_0123456789ab", iso(2_000));
    assert.equal(cancelled, 1);
    assert.equal(store.getDelivery(accepted.id)?.status, "accepted");
    assert.equal(store.getDelivery(pending.id)?.status, "cancelled");
    assert.equal(store.heads(5_000, 10).length, 0);
  } finally {
    store.close();
    await home.cleanup();
  }
});
