import assert from "node:assert/strict";
import { UserError } from "./errors.ts";
import { parse } from "./parse.ts";

function fails(argv: string[], fragment: string): void {
  assert.throws(() => parse(argv), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(
      err.message,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    return true;
  });
}

Deno.test("parser wymaga dokładnie jednego trybu i znanego zdarzenia", () => {
  fails([], "dokładnie jeden tryb");
  fails([
    "--once=forgejo-issue-closed",
    "--on=forgejo-issue-closed",
    "--wake-up=s",
  ], "dokładnie jeden tryb");
  fails(["--once=nie-ma", "--wake-up=s"], "Nieznane zdarzenie");
  fails(["--once=forgejo-issue-closed"], "wake-up");
  fails(["--bogus=1"], "Nieznana flaga");
  fails([
    "--once=forgejo-issue-closed",
    "--wake-up=s",
    "--once=forgejo-issue-closed",
  ], "drugi raz");
  fails(
    ["--mail-from=a@b.co", "--wake-up=s", "--once=forgejo-issue-closed"],
    "nie dotyczy",
  );
  fails(["nope"], "Nieznane polecenie");
  fails(["daemon", "extra"], "nie przyjmuje");
  fails(["show"], "identyfikatora");
  fails(["show", "363"], "Nieprawidłowy identyfikator");
  fails(["list", "--once=forgejo-issue-closed"], "dokładnie jeden tryb");
  fails(["--help", "x"], "osobnym wywołaniem");
  fails(["--once="], "wymaga wartości");
});

Deno.test("parser przyjmuje filtry zdarzenia i zostawia domyślny folder", () => {
  const forgejo = parse([
    "--once",
    "forgejo-issue-closed",
    "--wake-up",
    "thread-1",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=acme/dg",
    "--forgejo-issue=363",
  ]);
  assert.equal(forgejo.kind, "add");
  fails(
    [
      "--once=forgejo-issue-closed",
      "--wake-up=thread 1",
      "--forgejo-url=https://git.example.com",
      "--forgejo-repo=dg",
      "--forgejo-issue=1",
    ],
    "odstępu",
  );

  const mail = parse([
    "--on=zoho-mail-received",
    "--wake-up=sess",
    "--zoho-profile=zoho",
    "--mail-from=A@B.co",
  ]);
  assert.equal(mail.kind, "add");
  if (mail.kind !== "add") return;
  assert.equal(mail.mode, "on");
  assert.equal(mail.event, "zoho-mail-received");
  assert.equal(mail.flags["mail-folder"], undefined);
  assert.equal(mail.flags["mail-from"], "A@B.co");

  const zulip = parse([
    "--once=zulip-message-received",
    "--wake-up=sess",
    "--zulip-profile=zulip",
    "--zulip-stream=development",
  ]);
  assert.equal(zulip.kind, "add");
  if (zulip.kind !== "add") return;
  assert.equal(zulip.flags["zulip-topic"], undefined);

  assert.deepEqual(parse(["daemon"]), { kind: "daemon" });
  assert.deepEqual(parse(["list"]), { kind: "list" });
  assert.deepEqual(parse(["status"]), { kind: "status" });
  assert.deepEqual(parse(["--help"]), { kind: "help" });
  assert.deepEqual(parse(["show", "w_0123456789ab"]), {
    kind: "show",
    id: "w_0123456789ab",
  });
  assert.deepEqual(parse(["remove", "w_0123456789ab"]), {
    kind: "remove",
    id: "w_0123456789ab",
  });
});

Deno.test("brakujące filtry źródła są odrzucane", () => {
  fails([
    "--once=forgejo-issue-closed",
    "--wake-up=s",
    "--forgejo-url=https://git.example.com",
  ], "forgejo-repo");
  fails(["--once=zoho-mail-received", "--wake-up=s"], "zoho-profile");
  fails(
    ["--once=zulip-message-received", "--wake-up=s", "--zulip-profile=z"],
    "zulip-stream",
  );
  fails([
    "--on=forgejo-issue-commented",
    "--wake-up=s",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=acme/dg",
    "--forgejo-issue=363",
  ], "jednorazowa");
  const comment = parse([
    "--once=forgejo-issue-commented",
    "--wake-up=sess",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=acme/dg",
    "--forgejo-issue=363",
  ]);
  assert.equal(comment.kind, "add");
  if (comment.kind !== "add") return;
  assert.equal(comment.mode, "once");
  assert.equal(comment.event, "forgejo-issue-commented");
  fails([
    "--on=forgejo-pull-activity",
    "--wake-up=s",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=acme/dg",
    "--forgejo-issue=12",
  ], "nie dotyczy");
  const pull = parse([
    "--on=forgejo-pull-activity",
    "--wake-up=sess",
    "--forgejo-url=https://git.example.com",
    "--forgejo-repo=acme/dg",
    "--forgejo-pull=12",
  ]);
  assert.equal(pull.kind, "add");
  if (pull.kind !== "add") return;
  assert.equal(pull.mode, "on");
  assert.equal(pull.event, "forgejo-pull-activity");
});
