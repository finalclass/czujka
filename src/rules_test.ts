import assert from "node:assert/strict";
import { iso } from "./clock.ts";
import { interpret } from "./rules.ts";
import {
  forgejoState,
  forgejoWatch,
  zohoWatch,
  zulipWatch,
} from "./testing.ts";
import type { Cursor, ObservedMessage, Watch } from "./types.ts";

const T0 = 1_700_000_000_000;

function mailCursor(uid: number, uidValidity = "1"): Cursor {
  return { kind: "mail", folder: "INBOX", uidValidity, uid };
}

function message(
  order: number,
  extra: Partial<ObservedMessage> = {},
): ObservedMessage {
  return {
    key: `zoho:zoho:INBOX:1:${order}`,
    order,
    summary: `wiadomość ${order}`,
    url: null,
    from: "ada@example.com",
    subject: "Raport dzienny",
    topic: null,
    stream: null,
    cursorAfter: mailCursor(order),
    ...extra,
  };
}

Deno.test("Forgejo: once reaguje na już zamknięte, on tylko na przejście", () => {
  const once = interpret(
    forgejoWatch({ mode: "once" }),
    forgejoState("closed"),
    T0,
  );
  assert.equal(once.phase, "holding");
  assert.equal(once.events.length, 1);
  assert.equal(once.events[0].key.endsWith(":close:1"), true);
  assert.equal(
    once.cursor && once.cursor.kind === "forgejo" && once.cursor.state,
    "closed",
  );

  const armed = interpret(
    forgejoWatch({ mode: "on" }),
    forgejoState("closed"),
    T0,
  );
  assert.equal(armed.events.length, 0);
  assert.equal(armed.phase, "active");
  assert.equal(
    armed.cursor && armed.cursor.kind === "forgejo" && armed.cursor.transition,
    0,
  );

  const opened = interpret(
    forgejoWatch({
      cursor: { kind: "forgejo", state: "closed", transition: 0 },
    }),
    forgejoState("open"),
    T0,
  );
  assert.equal(opened.events.length, 0);
  const closed = interpret(
    forgejoWatch({ cursor: opened.cursor, mode: "on" }),
    forgejoState("closed"),
    T0 + 15_000,
  );
  assert.equal(closed.events.length, 1);
  assert.equal(closed.events[0].key.endsWith(":close:1"), true);
  const again = interpret(
    forgejoWatch({ cursor: closed.cursor, mode: "on" }),
    forgejoState("closed"),
    T0,
  );
  assert.equal(again.events.length, 0);
  const reopened = interpret(
    forgejoWatch({ cursor: closed.cursor, mode: "on" }),
    forgejoState("open"),
    T0,
  );
  const reclosed = interpret(
    forgejoWatch({ cursor: reopened.cursor, mode: "on" }),
    forgejoState("closed"),
    T0,
  );
  assert.equal(reclosed.events.length, 1);
  assert.equal(reclosed.events[0].key.endsWith(":close:2"), true);
});

Deno.test("Forgejo: otwarte issue i błąd odczytu nie są zdarzeniem", () => {
  const open = interpret(forgejoWatch(), forgejoState("open"), T0);
  assert.equal(open.events.length, 0);
  assert.equal(open.nextCheckAt, iso(T0 + 15_000));
  assert.equal(open.failures, 0);

  const watched = forgejoWatch({
    cursor: { kind: "forgejo", state: "open", transition: 0 },
    failures: 0,
  });
  const failed = interpret(watched, {
    type: "error",
    message: "404 nie jest zamknięciem",
  }, T0);
  assert.equal(failed.events.length, 0);
  assert.deepEqual(failed.cursor, watched.cursor);
  assert.equal(failed.failures, 1);
  assert.equal(failed.lastError, "404 nie jest zamknięciem");
  assert.equal(failed.nextCheckAt, iso(T0 + 15_000));

  const limited = interpret(watched, {
    type: "error",
    message: "limit",
    retryAfterMs: 40_000,
  }, T0);
  assert.equal(limited.nextCheckAt, iso(T0 + 40_000));

  const other = interpret(watched, forgejoState("closed", 364), T0);
  assert.equal(other.events.length, 0);
  assert.deepEqual(other.cursor, watched.cursor);
});

Deno.test("mail i Zulip: punkt startowy bez historii, potem kolejność i once", () => {
  const fresh = zohoWatch();
  const refused = interpret(fresh, {
    type: "messages",
    cursor: mailCursor(3),
    messages: [message(2), message(3)],
  }, T0);
  assert.equal(refused.phase, "initializing");
  assert.equal(refused.cursor, null);
  assert.equal(refused.events.length, 0);

  const baseline = interpret(
    fresh,
    { type: "baseline", cursor: mailCursor(9) },
    T0,
  );
  assert.equal(baseline.phase, "active");
  assert.equal(baseline.events.length, 0);
  assert.deepEqual(baseline.cursor, mailCursor(9));

  const again = interpret(
    zohoWatch({ cursor: baseline.cursor, phase: "active" }),
    {
      type: "baseline",
      cursor: mailCursor(20),
    },
    T0,
  );
  assert.deepEqual(again.cursor, baseline.cursor);
  assert.match(again.lastError ?? "", /już zapisany/);

  const active = zohoWatch({
    phase: "active",
    cursor: mailCursor(1),
    filters: {
      event: "zoho-mail-received",
      profile: "zoho",
      secretProfile: "zoho",
      folder: "INBOX",
      from: "ada@example.com",
      subjectContains: "raport",
    },
  });
  const once = interpret({ ...active, mode: "once" }, {
    type: "messages",
    cursor: mailCursor(9),
    messages: [
      message(5, { from: "ada@example.com", subject: "Raport" }),
      message(2, { from: "ADA@example.com", subject: "raport dzienny" }),
      message(9, { from: "ada@example.com", subject: "raport" }),
    ],
  }, T0);
  assert.equal(once.phase, "holding");
  assert.deepEqual(once.events.map((event) => event.key), [
    "zoho:zoho:INBOX:1:2",
  ]);
  assert.deepEqual(once.cursor, mailCursor(2));

  const ordered = interpret(active, {
    type: "messages",
    cursor: mailCursor(9),
    messages: [
      message(4, { from: "inny@example.com", subject: "raport" }),
      message(7, { subject: "axb" }),
      message(3, { subject: "a.b raport" }),
      message(8, { subject: "RAPORT końcowy" }),
    ],
  }, T0);
  assert.deepEqual(ordered.events.map((event) => event.key), [
    "zoho:zoho:INBOX:1:3",
    "zoho:zoho:INBOX:1:8",
  ]);
  assert.deepEqual(ordered.cursor, mailCursor(8));

  const literal = interpret({
    ...active,
    filters: {
      event: "zoho-mail-received",
      profile: "zoho",
      secretProfile: "zoho",
      folder: "INBOX",
      from: null,
      subjectContains: "a.b",
    },
  }, {
    type: "messages",
    cursor: mailCursor(4),
    messages: [
      message(3, { subject: "axb" }),
      message(4, { subject: "A.B koniec" }),
    ],
  }, T0);
  assert.deepEqual(literal.events.map((event) => event.key), [
    "zoho:zoho:INBOX:1:4",
  ]);

  const reset = interpret(active, {
    type: "reset",
    cursor: mailCursor(1, "2"),
    note: "Przerwano ciągłość obserwacji",
  }, T0);
  assert.equal(reset.events.length, 0);
  assert.equal(reset.continuity, "Przerwano ciągłość obserwacji");
  assert.deepEqual(reset.cursor, mailCursor(1, "2"));
});

Deno.test("Zulip: temat jest dokładny, a edycja nie tworzy nowego klucza", () => {
  const watch: Watch = zulipWatch({
    phase: "active",
    cursor: {
      kind: "zulip",
      site: "https://zulip.example.com",
      streamId: 7,
      lastId: 10,
    },
    filters: {
      event: "zulip-message-received",
      profile: "zulip",
      secretProfile: "zulip",
      stream: "development",
      topic: "release",
    },
  });
  const result = interpret(watch, {
    type: "messages",
    cursor: {
      kind: "zulip",
      site: "https://zulip.example.com",
      streamId: 7,
      lastId: 12,
    },
    messages: [
      {
        key: "zulip:https://zulip.example.com:7:11",
        order: 11,
        summary: "temat inny",
        url: "https://zulip.example.com/#narrow/near/11",
        from: "ada@example.com",
        subject: null,
        topic: "Release",
        stream: "development",
        cursorAfter: {
          kind: "zulip",
          site: "https://zulip.example.com",
          streamId: 7,
          lastId: 11,
        },
      },
      {
        key: "zulip:https://zulip.example.com:7:12",
        order: 12,
        summary: "pasuje",
        url: "https://zulip.example.com/#narrow/near/12",
        from: "ada@example.com",
        subject: null,
        topic: "release",
        stream: "development",
        cursorAfter: {
          kind: "zulip",
          site: "https://zulip.example.com",
          streamId: 7,
          lastId: 12,
        },
      },
    ],
  }, T0);
  assert.deepEqual(result.events.map((event) => event.key), [
    "zulip:https://zulip.example.com:7:12",
  ]);
  const anyTopic = interpret({
    ...watch,
    filters: {
      event: "zulip-message-received",
      profile: "zulip",
      secretProfile: "zulip",
      stream: "development",
      topic: null,
    },
  }, {
    type: "messages",
    cursor: {
      kind: "zulip",
      site: "https://zulip.example.com",
      streamId: 7,
      lastId: 11,
    },
    messages: [{
      key: "zulip:https://zulip.example.com:7:11",
      order: 11,
      summary: "kanał",
      url: null,
      from: null,
      subject: null,
      topic: "cokolwiek",
      stream: "development",
      cursorAfter: {
        kind: "zulip",
        site: "https://zulip.example.com",
        streamId: 7,
        lastId: 11,
      },
    }],
  }, T0);
  assert.equal(anyTopic.events.length, 1);
});

Deno.test("komentarz: punkt startowy, jeden najwcześniejszy i brak kolejnych", () => {
  const filters = {
    event: "forgejo-issue-commented" as const,
    origin: "https://git.example.com",
    owner: "acme",
    repo: "dg",
    issue: 363,
    profile: "forgejo",
  };
  const fresh = forgejoWatch({
    mode: "once",
    phase: "initializing",
    filters,
    cursor: null,
  });
  const baseline = interpret(fresh, {
    type: "baseline",
    cursor: { kind: "forgejo-comment", lastId: 5 },
  }, T0);
  assert.equal(baseline.phase, "active");
  assert.equal(baseline.events.length, 0);
  assert.deepEqual(baseline.cursor, { kind: "forgejo-comment", lastId: 5 });

  const armed = forgejoWatch({
    mode: "once",
    phase: "active",
    filters,
    cursor: baseline.cursor,
  });
  const once = interpret(armed, {
    type: "messages",
    cursor: { kind: "forgejo-comment", lastId: 9 },
    messages: [
      {
        key: "forgejo-comment:https://git.example.com:acme/dg#363:9",
        order: 9,
        summary: "późniejszy",
        url: null,
        from: "ada",
        subject: null,
        topic: null,
        stream: null,
        cursorAfter: { kind: "forgejo-comment", lastId: 9 },
      },
      {
        key: "forgejo-comment:https://git.example.com:acme/dg#363:8",
        order: 8,
        summary: "wcześniejszy",
        url: null,
        from: "ola",
        subject: null,
        topic: null,
        stream: null,
        cursorAfter: { kind: "forgejo-comment", lastId: 8 },
      },
    ],
  }, T0);
  assert.equal(once.phase, "holding");
  assert.deepEqual(once.events.map((event) => event.key), [
    "forgejo-comment:https://git.example.com:acme/dg#363:8",
  ]);
  assert.deepEqual(once.cursor, { kind: "forgejo-comment", lastId: 8 });

  const held = interpret(
    forgejoWatch({
      mode: "once",
      phase: "holding",
      filters,
      cursor: once.cursor,
    }),
    {
      type: "messages",
      cursor: { kind: "forgejo-comment", lastId: 11 },
      messages: [],
    },
    T0 + 15_000,
  );
  assert.equal(held.events.length, 0);
  assert.equal(held.phase, "holding");
  assert.deepEqual(held.cursor, once.cursor);
});
