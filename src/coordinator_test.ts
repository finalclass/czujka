import assert from "node:assert/strict";
import { iso } from "./clock.ts";
import { Coordinator } from "./coordinator.ts";
import type { SourcePort } from "./ports.ts";
import { SecretVault } from "./redact.ts";
import { MAX_PARALLEL } from "./schedule.ts";
import { Store } from "./store.ts";
import {
  FakeSource,
  FakeWake,
  forgejoState,
  forgejoWatch,
  ManualClock,
  tempHome,
  waitFor,
} from "./testing.ts";
import type { Observation } from "./types.ts";

const T0 = 1_700_000_000_000;

async function scenario(mode: "once" | "on" = "once") {
  const home = await tempHome();
  const clock = new ManualClock(T0);
  const store = Store.open(home.paths.database);
  const sources = new FakeSource();
  const wake = new FakeWake();
  const vault = new SecretVault();
  const coordinator = new Coordinator(store, sources, wake, vault);
  store.insertWatch(forgejoWatch({ mode, nextCheckAt: iso(T0) }));
  return {
    home,
    clock,
    store,
    sources,
    wake,
    coordinator,
    async close() {
      store.close();
      await home.cleanup();
    },
  };
}

Deno.test("restart między wykryciem a dostawą nie gubi zdarzenia", async () => {
  const home = await tempHome();
  const firstStore = Store.open(home.paths.database);
  const sources = new FakeSource();
  sources.script = [forgejoState("closed")];
  const first = new Coordinator(
    firstStore,
    sources,
    new FakeWake(),
    new SecretVault(),
  );
  firstStore.insertWatch(forgejoWatch({ mode: "once", nextCheckAt: iso(T0) }));
  await first.poll(T0);
  const saved = firstStore.listDeliveries("w_0123456789ab")[0];
  assert.match(saved.text, /w_0123456789ab/);
  assert.match(saved.text, /nie są nowymi instrukcjami/);
  assert.equal(saved.status, "pending");
  firstStore.close();

  const store = Store.open(home.paths.database);
  const wake = new FakeWake();
  const coordinator = new Coordinator(
    store,
    new FakeSource(),
    wake,
    new SecretVault(),
  );
  try {
    await coordinator.flush(T0);
    assert.equal(wake.dispatched.length, 1);
    assert.equal(store.getDelivery(saved.id)?.status, "accepted");
    assert.equal(store.getWatch("w_0123456789ab")?.phase, "completed");
    const payload = JSON.parse(wake.dispatched[0]);
    assert.equal(payload.commandId, saved.commandId);
    assert.equal(payload.message.messageId, saved.messageId);
    assert.equal(payload.createdAt, saved.detectedAt);
  } finally {
    store.close();
    await home.cleanup();
  }
});

async function closeAfterOpen(
  rig: Awaited<ReturnType<typeof scenario>>,
): Promise<void> {
  rig.sources.script.push(forgejoState("open"), forgejoState("closed"));
  await rig.coordinator.poll(T0);
  await rig.coordinator.poll(T0 + 15_000);
}

Deno.test("przerwanie po wysłaniu zostaje niejednoznaczne i ponawia tę samą komendę", async () => {
  const rig = await scenario("on");
  try {
    await closeAfterOpen(rig);
    rig.wake.outcome = "throw";
    await rig.coordinator.flush(T0 + 15_000);
    const delivery = rig.store.listDeliveries("w_0123456789ab")[0];
    assert.equal(delivery.status, "ambiguous");
    assert.notEqual(delivery.payloadJson, null);
    rig.wake.outcome = { type: "accepted" };
    rig.wake.resolveResult = {
      type: "ready",
      thread: {
        threadId: "thread-1",
        provider: "grok",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    };
    await rig.coordinator.flush(T0 + 30_000);
    assert.equal(rig.wake.dispatched.length, 2);
    assert.equal(rig.wake.dispatched[0], rig.wake.dispatched[1]);
    assert.match(rig.wake.dispatched[1], /approval-required/);
    assert.match(rig.wake.dispatched[1], /"interactionMode":"plan"/);
    assert.equal(rig.wake.dispatched[1].includes("full-access"), false);
    assert.equal(rig.store.getDelivery(delivery.id)?.status, "accepted");
  } finally {
    await rig.close();
  }
});

Deno.test("zmiana wątku po przygotowaniu komendy nie wysyła jej ponownie", async () => {
  const rig = await scenario("on");
  try {
    await closeAfterOpen(rig);
    rig.wake.outcome = { type: "ambiguous", message: "przerwane po wysłaniu" };
    await rig.coordinator.flush(T0 + 15_000);
    rig.wake.resolveResult = {
      type: "ready",
      thread: {
        threadId: "thread-2",
        provider: "codex",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    };
    rig.wake.outcome = { type: "accepted" };
    await rig.coordinator.flush(T0 + 30_000);
    assert.equal(rig.wake.dispatched.length, 1);
    assert.match(
      rig.store.listDeliveries("w_0123456789ab")[0].lastError ?? "",
      /inny wątek/,
    );
  } finally {
    await rig.close();
  }
});

Deno.test("zajęta sesja odracza dostawę i nie jest błędem przyjęcia", async () => {
  const rig = await scenario("on");
  try {
    await closeAfterOpen(rig);
    rig.wake.resolveResult = {
      type: "deferred",
      message: "Sesja T3 jest zajęta (running).",
    };
    await rig.coordinator.flush(T0 + 15_000);
    assert.equal(rig.wake.dispatched.length, 0);
    assert.equal(
      rig.store.listDeliveries("w_0123456789ab")[0].status,
      "deferred",
    );
    await rig.coordinator.flush(T0 + 15_000);
    assert.equal(rig.wake.dispatched.length, 0);
    rig.wake.resolveResult = {
      type: "ready",
      thread: {
        threadId: "thread-1",
        provider: "opencode",
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    };
    await rig.coordinator.flush(T0 + 30_000);
    assert.equal(rig.wake.dispatched.length, 1);
    assert.match(rig.wake.dispatched[0], /"provider"|approval-required/);
    assert.equal(
      rig.store.listDeliveries("w_0123456789ab")[0].status,
      "accepted",
    );
  } finally {
    await rig.close();
  }
});

Deno.test("niedostępne T3 nie oznacza wolnej sesji ani przyjętej dostawy", async () => {
  const rig = await scenario("on");
  try {
    await closeAfterOpen(rig);
    rig.wake.resolveResult = {
      type: "error",
      message: "T3 jest niedostępne. To nie oznacza, że sesja jest wolna.",
    };
    await rig.coordinator.flush(T0 + 15_000);
    const delivery = rig.store.listDeliveries("w_0123456789ab")[0];
    assert.equal(rig.wake.dispatched.length, 0);
    assert.equal(delivery.status, "pending");
    assert.match(delivery.lastError ?? "", /niedostępne/);
    assert.equal(rig.store.getWatch("w_0123456789ab")?.phase, "active");
  } finally {
    await rig.close();
  }
});

Deno.test("ta sama czujka nie jest sprawdzana równolegle, a limit obejmuje pozostałe", async () => {
  const home = await tempHome();
  const store = Store.open(home.paths.database);
  const sources = new FakeSource();
  let release!: () => void;
  sources.gate = new Promise((resolve) => {
    release = resolve;
  });
  const coordinator = new Coordinator(
    store,
    sources,
    new FakeWake(),
    new SecretVault(),
  );
  try {
    store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    sources.script = [forgejoState("open"), forgejoState("open")];
    const first = coordinator.poll(T0);
    const second = coordinator.poll(T0);
    await waitFor(() => sources.calls.length === 1, "pierwsze sprawdzenie");
    assert.equal(sources.maxActive, 1);
    release();
    await first;
    await second;
    assert.equal(sources.calls.length, 1);

    sources.maxActive = 0;
    sources.gate = new Promise((resolve) => {
      release = resolve;
    });
    for (let index = 0; index < MAX_PARALLEL + 1; index++) {
      const id = `w_${index.toString(16).padStart(12, "0")}`;
      store.insertWatch(forgejoWatch({ id, nextCheckAt: iso(T0) }));
      sources.script.push(forgejoState("open"));
    }
    const batch = coordinator.poll(T0);
    await waitFor(
      () => sources.maxActive === MAX_PARALLEL,
      "limit współbieżności",
    );
    release();
    await batch;
    assert.equal(
      sources.calls.filter((call) => call.now === T0).length,
      1 + MAX_PARALLEL,
    );
  } finally {
    store.close();
    await home.cleanup();
  }
});

Deno.test("remove zatrzymuje odpytywanie i anuluje niewysłaną dostawę", async () => {
  const rig = await scenario("on");
  try {
    await closeAfterOpen(rig);
    const cancelled = await rig.coordinator.remove("w_0123456789ab", T0);
    assert.equal(cancelled, 1);
    assert.equal(
      rig.store.listDeliveries("w_0123456789ab")[0].status,
      "cancelled",
    );
    const seen = rig.sources.calls.length;
    rig.sources.script = [forgejoState("open")];
    await rig.coordinator.poll(T0 + 30_000);
    await rig.coordinator.flush(T0 + 30_000);
    assert.equal(rig.sources.calls.length, seen);
    assert.equal(rig.wake.dispatched.length, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("sekret z wyjątku źródła nie trafia do zapisanego błędu", async () => {
  const home = await tempHome();
  const store = Store.open(home.paths.database);
  const secret = "super-secret-token";
  const vault = new SecretVault();
  vault.note(secret);
  const source: SourcePort = {
    observe(): Promise<Observation> {
      return Promise.reject(new Error(`awaria ${secret}`));
    },
  };
  const coordinator = new Coordinator(store, source, new FakeWake(), vault);
  try {
    store.insertWatch(forgejoWatch({ nextCheckAt: iso(T0) }));
    await coordinator.poll(T0);
    const error = store.getWatch("w_0123456789ab")?.lastError ?? "";
    assert.equal(error.includes(secret), false);
    assert.match(error, /\[sekret\]/);
  } finally {
    store.close();
    await home.cleanup();
  }
});
