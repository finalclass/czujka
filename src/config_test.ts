import assert from "node:assert/strict";
import { compileWatch, loadConfig, parseConfig } from "./config.ts";
import { UserError } from "./errors.ts";
import { parse } from "./parse.ts";
import { resolvePaths, resolveT3Paths } from "./paths.ts";
import { tempHome } from "./testing.ts";

Deno.test("ścieżki XDG ignorują względne wartości i przyjmują nadpisania", () => {
  const paths = resolvePaths({
    HOME: "/home/example",
    XDG_CONFIG_HOME: "relative",
    XDG_DATA_HOME: "relative",
  });
  assert.equal(paths.configDir, "/home/example/.config/czujka");
  assert.equal(paths.configFile, "/home/example/.config/czujka/config.json");
  assert.equal(paths.dataDir, "/home/example/.local/share/czujka");
  assert.equal(
    paths.database,
    "/home/example/.local/share/czujka/state.sqlite",
  );
  assert.equal(paths.socket, "/home/example/.local/share/czujka/daemon.sock");
  assert.equal(paths.token, "/home/example/.local/share/czujka/t3.token");

  const xdg = resolvePaths({
    HOME: "/home/example",
    XDG_CONFIG_HOME: "/srv/config",
    XDG_DATA_HOME: "/srv/data/",
  });
  assert.equal(xdg.configDir, "/srv/config/czujka");
  assert.equal(xdg.dataDir, "/srv/data/czujka");

  const override = resolvePaths({
    HOME: "/home/example",
    CZUJKA_CONFIG_DIR: "/tmp/cfg",
    CZUJKA_DATA_DIR: "/tmp/data",
  });
  assert.equal(override.configDir, "/tmp/cfg");
  assert.equal(override.dataDir, "/tmp/data");

  assert.throws(
    () => resolvePaths({ HOME: "/home/example", CZUJKA_DATA_DIR: "relative" }),
    /bezwzględną/,
  );
  assert.throws(() => resolvePaths({}), /HOME/);
  const t3 = resolveT3Paths({
    HOME: "/home/example",
    CZUJKA_T3_DB: "/tmp/t3.sqlite",
    CZUJKA_T3_RUNTIME: "/tmp/runtime.json",
  });
  assert.equal(t3.database, "/tmp/t3.sqlite");
  assert.equal(t3.runtime, "/tmp/runtime.json");
  assert.equal(
    resolveT3Paths({ HOME: "/home/example" }).database,
    "/home/example/.t3/userdata/state.sqlite",
  );
});

Deno.test("konfiguracja wiąże profil Forgejo z originem i nie trzyma sekretów", () => {
  assert.throws(
    () =>
      parseConfig({
        forgejo: { "https://git.example.com": { profile: "f", token: "x" } },
      }),
    /Sekrety nie należą/,
  );
  assert.throws(
    () =>
      parseConfig({
        forgejo: {
          "https://git.example.com": { profile: "a" },
          "https://git.example.com/": { profile: "b" },
        },
      }),
    /drugi raz/,
  );
  const config = parseConfig({
    forgejo: {
      "https://git.example.com": { profile: "forgejo", defaultOwner: "acme" },
    },
    zoho: { praca: { profile: "zoho-secrets" } },
    zulip: { firma: { profile: "zulip-secrets" } },
  });

  const short = parse([
    "--once=forgejo-issue-closed",
    "--wake-up=thread-1",
    "--forgejo-url=https://git.example.com/",
    "--forgejo-repo=dg",
    "--forgejo-issue=363",
  ]);
  assert.equal(short.kind, "add");
  if (short.kind !== "add") return;
  const watch = compileWatch(
    short,
    config,
    "w_0123456789ab",
    1_700_000_000_000,
  );
  assert.equal(watch.phase, "active");
  assert.equal(watch.filters.event, "forgejo-issue-closed");
  if (watch.filters.event !== "forgejo-issue-closed") return;
  assert.equal(watch.filters.owner, "acme");
  assert.equal(watch.filters.repo, "dg");
  assert.equal(watch.filters.profile, "forgejo");
  assert.equal(watch.nextCheckAt, new Date(1_700_000_000_000).toISOString());

  const full = parse([
    "--on=forgejo-issue-closed",
    "--wake-up=thread-1",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=other/dg",
    "--forgejo-issue=8",
  ]);
  if (full.kind !== "add") return;
  const named = compileWatch(full, config, "w_abcdefabcdef", 0);
  if (named.filters.event !== "forgejo-issue-closed") return;
  assert.equal(named.filters.owner, "other");
  assert.equal(named.mode, "on");

  const comment = parse([
    "--once=forgejo-issue-commented",
    "--wake-up=thread-1",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=dg",
    "--forgejo-issue=363",
  ]);
  if (comment.kind !== "add") return;
  const commented = compileWatch(comment, config, "w_0123456789ab", 0);
  assert.equal(commented.phase, "initializing");
  assert.equal(commented.mode, "once");
  if (commented.filters.event !== "forgejo-issue-commented") return;
  assert.equal(commented.filters.owner, "acme");
  assert.equal(commented.filters.issue, 363);

  const pull = parse([
    "--on=forgejo-pull-activity",
    "--wake-up=thread-1",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=dg",
    "--forgejo-pull=12",
  ]);
  if (pull.kind !== "add") return;
  const activity = compileWatch(pull, config, "w_0123456789ab", 0);
  assert.equal(activity.phase, "initializing");
  assert.equal(activity.mode, "on");
  if (activity.filters.event !== "forgejo-pull-activity") return;
  assert.equal(activity.filters.pull, 12);
  assert.equal(activity.filters.owner, "acme");

  delete config.forgejo["https://git.example.com"].defaultOwner;
  assert.throws(
    () => compileWatch(short, config, "w_0123456789ab", 0),
    /Brak właściciela/,
  );
});

Deno.test("profile Zoho i Zulip oraz brak pliku konfiguracji", async () => {
  const home = await tempHome();
  try {
    await assert.rejects(() => loadConfig(home.paths.configFile), UserError);
    const config = parseConfig({
      zoho: { zoho: { profile: "zoho-secrets" } },
      zulip: { zulip: { profile: "zulip-secrets" } },
    });
    const mail = parse([
      "--once=zoho-mail-received",
      "--wake-up=thread-1",
      "--zoho-profile=zoho",
      "--mail-from=Ada@Example.com",
      "--mail-subject-contains=Raport",
    ]);
    if (mail.kind !== "add") return;
    const watch = compileWatch(mail, config, "w_0123456789ab", 0);
    if (watch.filters.event !== "zoho-mail-received") return;
    assert.equal(watch.phase, "initializing");
    assert.equal(watch.filters.folder, "INBOX");
    assert.equal(watch.filters.from, "ada@example.com");
    assert.equal(watch.filters.secretProfile, "zoho-secrets");
    assert.equal(watch.filters.subjectContains, "Raport");

    const badFrom = parse([
      "--once=zoho-mail-received",
      "--wake-up=thread-1",
      "--zoho-profile=zoho",
      "--mail-from=Ada",
    ]);
    if (badFrom.kind !== "add") return;
    assert.throws(
      () => compileWatch(badFrom, config, "w_0123456789ab", 0),
      /adresem/,
    );
    assert.throws(
      () =>
        compileWatch(
          {
            kind: "add",
            mode: "on",
            event: "zulip-message-received",
            wakeTarget: "thread-1",
            flags: { "zulip-profile": "brak", "zulip-stream": "development" },
          },
          config,
          "w_0123456789ab",
          0,
        ),
      /Brak profilu Zulip/,
    );
  } finally {
    await home.cleanup();
  }
});
