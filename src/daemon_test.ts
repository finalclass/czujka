import assert from "node:assert/strict";
import { serve } from "./daemon.ts";
import { run } from "./cli.ts";
import { AlreadyRunningError } from "./errors.ts";
import { DAEMON_MISSING } from "./ipc.ts";
import type { SourcePort } from "./ports.ts";
import { SecretVault } from "./redact.ts";
import { Store } from "./store.ts";
import { Coordinator } from "./coordinator.ts";
import {
  bufferIO,
  FakeWake,
  forgejoState,
  ManualClock,
  tempHome,
  waitFor,
} from "./testing.ts";
import type { Observation, Watch } from "./types.ts";

const T0 = 1_700_000_000_000;

const CONFIG = {
  forgejo: {
    "https://git.example.com": { profile: "forgejo", defaultOwner: "acme" },
  },
  zoho: { zoho: { profile: "zoho" } },
  zulip: { zulip: { profile: "zulip" } },
};

Deno.test("brak demona jest jawnym błędem, bez udawanego sukcesu", async () => {
  const home = await tempHome();
  try {
    const io = bufferIO();
    assert.equal(await run(["list"], home.env, io.io), 1);
    assert.deepEqual(io.lines, []);
    assert.equal(io.errors[0], DAEMON_MISSING);

    const help = bufferIO();
    assert.equal(await run(["--help"], home.env, help.io), 0);
    assert.match(help.lines[0], /czujka daemon/);

    const unknown = bufferIO();
    assert.equal(
      await run(["--once=nie-ma", "--wake-up=sesja"], home.env, unknown.io),
      1,
    );
    assert.match(unknown.errors[0], /Nieznane zdarzenie/);
    assert.equal(unknown.lines.length, 0);
  } finally {
    await home.cleanup();
  }
});

Deno.test("demon przyjmuje czujkę dopiero po zapisie, a druga instancja nie wstaje", async () => {
  const home = await tempHome();
  await Deno.writeTextFile(home.paths.configFile, JSON.stringify(CONFIG));
  await Deno.writeTextFile(home.paths.socket, "stary gniazdo");
  const store = Store.open(home.paths.database);
  const wake = new FakeWake();
  wake.resolveResult = {
    type: "deferred",
    message: "Sesja T3 jest zajęta (running).",
  };
  const calls: string[] = [];
  const source: SourcePort = {
    observe(watch: Watch): Promise<Observation> {
      calls.push(watch.id);
      if (watch.filters.event === "forgejo-issue-closed") {
        return Promise.resolve(forgejoState("closed"));
      }
      return Promise.resolve({
        type: "error",
        message: "źródło testowe nie ma jeszcze punktu startowego",
      });
    },
  };
  const coordinator = new Coordinator(store, source, wake, new SecretVault());
  const clock = new ManualClock(T0);
  let server: { stop(): Promise<void> } | null = null;
  try {
    server = await serve({
      paths: home.paths,
      coordinator,
      clock,
      vault: new SecretVault(),
      configPath: home.paths.configFile,
      tickMs: 60_000,
    });
    assert.equal(((await Deno.stat(home.paths.socket)).mode ?? 0) & 0o077, 0);
    assert.equal(((await Deno.stat(home.paths.dataDir)).mode ?? 0) & 0o077, 0);

    const empty = bufferIO();
    assert.equal(await run(["list"], home.env, empty.io), 0);
    assert.equal(empty.lines[0], "Brak czujek.");

    const added = bufferIO();
    assert.equal(
      await run(
        [
          "--once=forgejo-issue-closed",
          "--wake-up=thread-1",
          "--forgejo-url=https://git.example.com",
          "--forgejo-repo=dg",
          "--forgejo-issue=363",
        ],
        home.env,
        added.io,
      ),
      0,
    );
    assert.equal(added.lines.length, 1);
    const id = added.lines[0];
    assert.match(id, /^w_[0-9a-f]{12}$/);
    const saved = store.getWatch(id);
    assert.equal(saved?.wakeTarget, "thread-1");
    assert.equal(saved?.filters.event, "forgejo-issue-closed");
    if (saved?.filters.event === "forgejo-issue-closed") {
      assert.equal(saved.filters.owner, "acme");
    }
    await waitFor(
      () => calls.includes(id) && store.listDeliveries(id).length === 1,
      "pierwsza dostawa",
    );

    const shown = bufferIO();
    assert.equal(await run(["show", id], home.env, shown.io), 0);
    const text = shown.lines.join("\n");
    for (
      const fragment of [
        "oczekuje na dostawę",
        "cel=thread-1",
        "ostatnie sprawdzenie",
        "kolejne sprawdzenie",
        "ostatni błąd",
        "oczekująca dostawa",
      ]
    ) assert.match(text, new RegExp(fragment));

    const mail = bufferIO();
    assert.equal(
      await run(
        [
          "--on=zoho-mail-received",
          "--wake-up=thread-1",
          "--zoho-profile=zoho",
        ],
        home.env,
        mail.io,
      ),
      0,
    );
    const mailId = mail.lines[0];
    await waitFor(() => calls.includes(mailId), "sprawdzenie poczty");
    const mailShow = bufferIO();
    assert.equal(await run(["show", mailId], home.env, mailShow.io), 0);
    assert.match(mailShow.lines.join("\n"), /inicjalizacja/);

    const listed = bufferIO();
    assert.equal(await run(["list"], home.env, listed.io), 0);
    assert.match(listed.lines.join("\n"), new RegExp(id));
    assert.match(listed.lines.join("\n"), new RegExp(mailId));

    const status = bufferIO();
    assert.equal(await run(["status"], home.env, status.io), 0);
    assert.match(status.lines[0], new RegExp(`pid ${Deno.pid}`));
    assert.match(
      status.lines.join("\n"),
      new RegExp(home.paths.socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(status.lines.join("\n"), /Czujki: 2/);

    const removed = bufferIO();
    assert.equal(await run(["remove", id], home.env, removed.io), 0);
    assert.match(removed.lines[0], new RegExp(`Usunięto ${id}`));
    assert.match(removed.lines[0], /Anulowane dostawy: 1/);
    assert.equal(store.listDeliveries(id)[0].status, "cancelled");
    await coordinator.flush(T0 + 15_000);
    assert.equal(wake.dispatched.length, 0);
    assert.equal(store.getWatch(id)?.phase, "removed");

    const bogus = bufferIO();
    assert.equal(await run(["--bogus=1"], home.env, bogus.io), 1);
    assert.match(bogus.errors[0], /Nieznana flaga/);
    assert.equal(bogus.lines.length, 0);

    await Deno.remove(home.paths.configFile);
    const rejected = bufferIO();
    assert.equal(
      await run(
        [
          "--once=forgejo-issue-closed",
          "--wake-up=thread-1",
          "--forgejo-url=https://git.example.com",
          "--forgejo-repo=acme/dg",
          "--forgejo-issue=1",
        ],
        home.env,
        rejected.io,
      ),
      1,
    );
    assert.equal(rejected.lines.length, 0);
    assert.match(rejected.errors[0], /Brak konfiguracji/);

    await assert.rejects(() =>
      serve({
        paths: home.paths,
        coordinator,
        clock,
        vault: new SecretVault(),
        configPath: home.paths.configFile,
        tickMs: 60_000,
      }), AlreadyRunningError);
    const still = bufferIO();
    assert.equal(await run(["status"], home.env, still.io), 0);

    const duplicate = bufferIO();
    assert.equal(await run(["daemon"], home.env, duplicate.io), 2);
    assert.match(duplicate.errors[0], /już działa/);
    assert.equal(await run(["status"], home.env, bufferIO().io), 0);

    await server.stop();
    server = null;
    const down = bufferIO();
    assert.equal(await run(["list"], home.env, down.io), 1);
    assert.equal(down.errors[0], DAEMON_MISSING);

    server = await serve({
      paths: home.paths,
      coordinator,
      clock,
      vault: new SecretVault(),
      configPath: home.paths.configFile,
      tickMs: 60_000,
    });
    const restored = bufferIO();
    assert.equal(await run(["list"], home.env, restored.io), 0);
    const restoredText = restored.lines.join("\n");
    assert.match(restoredText, /inicjalizacja/);
    assert.match(restoredText, /usunięta/);
    assert.match(restoredText, new RegExp(mailId));
    assert.match(restoredText, new RegExp(id));
  } finally {
    if (server) await server.stop();
    store.close();
    await home.cleanup();
  }
});
