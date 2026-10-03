import assert from "node:assert/strict";
import { iso } from "../clock.ts";
import { Coordinator } from "../coordinator.ts";
import type { ByteConn } from "../imap.ts";
import { SecretVault } from "../redact.ts";
import { Store } from "../store.ts";
import { formatShow } from "../format.ts";
import { assertZohoHost, connectZoho, observeZoho } from "./zoho.ts";
import { LiveSources } from "./live.ts";
import {
  FakeWake,
  ManualClock,
  MemorySecrets,
  tempHome,
  zohoWatch,
} from "../testing.ts";
import type { MailCursor, Observation, ZohoFilters } from "../types.ts";

const T0 = 1_700_000_000_000;
const PASSWORD = "haslo-aplikacji-123";

type Mail = { uid: number; from: string; subject: string };
type Box = {
  uidValidity: string;
  uidNext: number;
  uids: Mail[];
  loginOk: boolean;
};

class ScriptImap implements ByteConn {
  private pending = "";
  private outgoing = new Uint8Array(0);
  readonly commands: string[] = [];

  constructor(private readonly reply: (body: string, tag: string) => string) {
    this.enqueue("* OK czujka\r\n");
  }

  private enqueue(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const merged = new Uint8Array(this.outgoing.length + bytes.length);
    merged.set(this.outgoing);
    merged.set(bytes, this.outgoing.length);
    this.outgoing = merged;
  }

  write(buffer: Uint8Array): Promise<number> {
    this.pending += new TextDecoder().decode(buffer);
    while (this.pending.includes("\n")) {
      const nl = this.pending.indexOf("\n");
      const line = this.pending.slice(0, nl).replace(/\r$/, "");
      this.pending = this.pending.slice(nl + 1);
      this.commands.push(line);
      const space = line.indexOf(" ");
      const tag = line.slice(0, space);
      this.enqueue(this.reply(line.slice(space + 1), tag));
    }
    return Promise.resolve(buffer.length);
  }

  read(buffer: Uint8Array): Promise<number | null> {
    if (this.outgoing.length === 0) return Promise.resolve(null);
    const n = Math.min(buffer.length, this.outgoing.length);
    buffer.set(this.outgoing.subarray(0, n));
    this.outgoing = this.outgoing.slice(n);
    return Promise.resolve(n);
  }

  close(): void {}
}

class HangImap implements ByteConn {
  private readers: Array<(value: number | null) => void> = [];

  read(): Promise<number | null> {
    return new Promise((resolve) => this.readers.push(resolve));
  }

  write(buffer: Uint8Array): Promise<number> {
    return Promise.resolve(buffer.length);
  }

  close(): void {
    for (const resolve of this.readers) resolve(null);
    this.readers = [];
  }
}

function script(box: Box): ScriptImap {
  return new ScriptImap((body, tag) => {
    if (body.startsWith("LOGIN")) {
      return box.loginOk ? `${tag} OK\r\n` : `${tag} NO\r\n`;
    }
    if (body.startsWith("EXAMINE")) {
      return `* OK [UIDVALIDITY ${box.uidValidity}] [UIDNEXT ${box.uidNext}]\r\n${tag} OK\r\n`;
    }
    if (body.startsWith("UID SEARCH")) {
      const start = Number(body.match(/UID SEARCH UID (\d+):\*/)![1]);
      const ids = box.uids.map((mail) => mail.uid).filter((uid) => uid >= start)
        .sort((a, b) => a - b);
      return `* SEARCH ${ids.join(" ")}\r\n${tag} OK\r\n`;
    }
    if (body.startsWith("UID FETCH")) {
      const wanted = body.match(/UID FETCH ([0-9,]+)/)![1].split(",").map(
        Number,
      );
      let out = "";
      for (const uid of wanted) {
        const mail = box.uids.find((item) => item.uid === uid);
        if (!mail) continue;
        const header =
          `From: ${mail.from}\r\nSubject: ${mail.subject}\r\nMessage-ID: <${uid}@example.com>\r\n\r\n`;
        const size = new TextEncoder().encode(header).length;
        out +=
          `* 1 FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${size}}\r\n${header})\r\n`;
      }
      return `${out}${tag} OK\r\n`;
    }
    if (body.startsWith("LOGOUT")) return `${tag} OK\r\n`;
    return `${tag} BAD\r\n`;
  });
}

function filters(extra: Partial<ZohoFilters> = {}): ZohoFilters {
  return {
    event: "zoho-mail-received",
    profile: "zoho",
    secretProfile: "zoho",
    folder: "INBOX",
    from: null,
    subjectContains: null,
    ...extra,
  };
}

function secretsOf(env: Record<string, string> = {}): MemorySecrets {
  return new MemorySecrets([{
    ZOHO_MAIL_USER: "ada@example.com",
    ZOHO_MAIL_APP_PASSWORD: PASSWORD,
    ...env,
  }]);
}

Deno.test("host IMAP Zoho jest ograniczony do domen Zoho", async () => {
  assertZohoHost("imappro.zoho.eu");
  assertZohoHost("imap.zoho.com");
  assert.throws(() => assertZohoHost("zoho.com.evil.net"), /zoho\.com/);
  assert.throws(() => assertZohoHost("evil.example"), /zoho\.com/);
  await assert.rejects(() => connectZoho("evil.example"), /zoho\.com/);
});

Deno.test("Zoho ustanawia punkt startowy bez historii i czyta tylko nagłówki", async () => {
  const box: Box = {
    uidValidity: "5",
    uidNext: 12,
    uids: [{ uid: 11, from: "Old <old@example.com>", subject: "stara" }],
    loginOk: true,
  };
  const conn = script(box);
  const result = await observeZoho(filters(), null, {
    secrets: secretsOf(),
    vault: new SecretVault(),
    connectImap: () => Promise.resolve(conn),
  });
  assert.equal(result.type, "baseline");
  if (result.type !== "baseline") return;
  const cursor = result.cursor as MailCursor;
  assert.equal(cursor.uidValidity, "5");
  assert.equal(cursor.uid, 11);
  const sent = conn.commands.join("\n");
  assert.match(sent, /EXAMINE/);
  assert.equal(sent.includes("UID SEARCH"), false);
  assert.equal(sent.includes("STORE"), false);
  assert.equal(/SELECT /.test(sent), false);
  assert.equal(sent.includes(PASSWORD), true);
});

Deno.test("nowe wiadomości, strony, powtórzenie i UIDVALIDITY", async () => {
  const box: Box = {
    uidValidity: "5",
    uidNext: 20,
    uids: [10, 11, 12, 13, 14].map((uid) => ({
      uid,
      from: uid === 10 ? "Jan <Ada@Example.com>" : "bob@example.com",
      subject: uid === 10 ? "=?utf-8?Q?Cze=C5=9B=C4=87?=" : "inne",
    })),
    loginOk: true,
  };
  const cursor: MailCursor = {
    kind: "mail",
    folder: "INBOX",
    uidValidity: "5",
    uid: 9,
  };
  const firstConn = script(box);
  const first = await observeZoho(filters(), cursor, {
    secrets: secretsOf(),
    vault: new SecretVault(),
    connectImap: () => Promise.resolve(firstConn),
    pageLimit: 2,
  });
  assert.equal(first.type, "messages");
  if (first.type !== "messages") return;
  assert.deepEqual(first.messages.map((item) => item.order), [10, 11]);
  assert.equal(first.messages[0].from, "ada@example.com");
  assert.equal(first.messages[0].subject, "Cześć");
  assert.match(firstConn.commands.join("\n"), /BODY\.PEEK\[HEADER\.FIELDS/);
  assert.equal(
    firstConn.commands.some((line) => line.includes("STORE")),
    false,
  );

  const second = await observeZoho(
    filters(),
    first.messages.at(-1)!.cursorAfter as MailCursor,
    {
      secrets: secretsOf(),
      vault: new SecretVault(),
      connectImap: () => Promise.resolve(script(box)),
      pageLimit: 2,
    },
  );
  assert.equal(second.type, "messages");
  if (second.type !== "messages") return;
  assert.deepEqual(second.messages.map((item) => item.order), [12, 13]);

  const third = await observeZoho(
    filters(),
    second.messages.at(-1)!.cursorAfter as MailCursor,
    {
      secrets: secretsOf(),
      vault: new SecretVault(),
      connectImap: () => Promise.resolve(script(box)),
      pageLimit: 2,
    },
  );
  assert.equal(third.type, "messages");
  if (third.type !== "messages") return;
  assert.deepEqual(third.messages.map((item) => item.order), [14]);

  const repeat = await observeZoho(filters(), { ...cursor, uid: 14 }, {
    secrets: secretsOf(),
    vault: new SecretVault(),
    connectImap: () => Promise.resolve(script(box)),
  });
  assert.equal(repeat.type, "messages");
  if (repeat.type === "messages") assert.equal(repeat.messages.length, 0);

  box.uidValidity = "9";
  box.uidNext = 4;
  box.uids = [{ uid: 1, from: "old@example.com", subject: "caly folder" }];
  const resetConn = script(box);
  const reset = await observeZoho(filters(), cursor, {
    secrets: secretsOf(),
    vault: new SecretVault(),
    connectImap: () => Promise.resolve(resetConn),
  });
  assert.equal(reset.type, "reset");
  if (reset.type !== "reset") return;
  assert.match(reset.note, /Przerwano ciągłość/);
  assert.match(reset.note, /UIDVALIDITY/);
  assert.equal((reset.cursor as MailCursor).uidValidity, "9");
  assert.equal((reset.cursor as MailCursor).uid, 3);
  assert.equal(
    resetConn.commands.some((line) => line.includes("UID SEARCH")),
    false,
  );
});

Deno.test("błąd logowania, timeout i obcy host nie są nową pocztą", async () => {
  const secrets = secretsOf();
  const failed = await observeZoho(filters(), null, {
    secrets,
    vault: new SecretVault(),
    connectImap: () =>
      Promise.resolve(
        script({ uidValidity: "1", uidNext: 1, uids: [], loginOk: false }),
      ),
  });
  assert.equal(failed.type, "error");
  if (failed.type === "error") {
    assert.equal(failed.message.includes(PASSWORD), false);
    assert.match(failed.message, /Logowanie IMAP/);
  }
  assert.equal(secrets.invalidations, 1);

  const host = await observeZoho(filters(), null, {
    secrets: secretsOf({ ZOHO_MAIL_IMAP_HOST: "evil.example" }),
    vault: new SecretVault(),
  });
  assert.equal(host.type, "error");
  if (host.type === "error") assert.match(host.message, /zoho\.com/);

  const timed = await Promise.race([
    observeZoho(filters(), null, {
      secrets: secretsOf(),
      vault: new SecretVault(),
      connectImap: () => Promise.resolve(new HangImap()),
      timeoutMs: 20,
    }),
    new Promise<Observation>((_resolve, reject) =>
      setTimeout(() => reject(new Error("timeout testu")), 1000)
    ),
  ]);
  assert.equal(timed.type, "error");
  if (timed.type === "error") {
    assert.match(timed.message, /Przekroczono czas oczekiwania na IMAP/);
    assert.equal(timed.message.includes(PASSWORD), false);
  }
});

async function flow(mode: "once" | "on") {
  const home = await tempHome();
  const clock = new ManualClock(T0);
  const store = Store.open(home.paths.database);
  const box: Box = {
    uidValidity: "5",
    uidNext: 12,
    uids: [{ uid: 11, from: "Old <old@example.com>", subject: "stara" }],
    loginOk: true,
  };
  const conns: ScriptImap[] = [];
  const vault = new SecretVault();
  const wake = new FakeWake();
  const coordinator = new Coordinator(
    store,
    new LiveSources({
      fetch: globalThis.fetch,
      secrets: secretsOf(),
      vault,
      now: () => clock.current,
      connectImap: () => {
        const conn = script(box);
        conns.push(conn);
        return Promise.resolve(conn);
      },
    }),
    wake,
    vault,
  );
  store.insertWatch(zohoWatch({
    mode,
    nextCheckAt: iso(T0),
    filters: filters({ from: "ada@example.com", subjectContains: "raport" }),
  }));
  return { home, clock, store, box, conns, wake, coordinator };
}

Deno.test("Zoho: baza bez historii, przestój i filtr, once bierze jedną", async () => {
  const rig = await flow("once");
  try {
    await rig.coordinator.poll(T0);
    assert.equal(rig.store.listDeliveries("w_0123456789ab").length, 0);
    assert.equal(rig.store.getWatch("w_0123456789ab")?.phase, "active");
    assert.equal(
      rig.conns[0].commands.some((line) => line.includes("UID SEARCH")),
      false,
    );
    const cursor = rig.store.getWatch("w_0123456789ab")?.cursor;
    assert.equal(cursor?.kind === "mail" && cursor.uid, 11);
    rig.box.uids.push(
      { uid: 12, from: "Bob <bob@example.com>", subject: "Raport" },
      { uid: 13, from: "Ada <ada@example.com>", subject: "Raport Q1" },
      { uid: 14, from: "Ada <ada@example.com>", subject: "inny raport" },
    );
    await rig.coordinator.poll(T0 + 15_000);
    const deliveries = rig.store.listDeliveries("w_0123456789ab");
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].eventKey, /:13$/);
    assert.equal(deliveries[0].summary.includes("stara"), false);
    assert.equal(rig.store.getWatch("w_0123456789ab")?.phase, "holding");
    await rig.coordinator.poll(T0 + 30_000);
    assert.equal(rig.conns.length, 2);
  } finally {
    rig.store.close();
    await rig.home.cleanup();
  }
});

Deno.test("Zoho: on zachowuje kolejność, restart i przerwanie UIDVALIDITY", async () => {
  const rig = await flow("on");
  try {
    await rig.coordinator.poll(T0);
    rig.store.close();
    const store = Store.open(rig.home.paths.database);
    const wake = new FakeWake();
    const vault = new SecretVault();
    const conns = rig.conns;
    const coordinator = new Coordinator(
      store,
      new LiveSources({
        fetch: globalThis.fetch,
        secrets: secretsOf(),
        vault,
        now: () => rig.clock.current,
        connectImap: () => {
          const conn = script(rig.box);
          conns.push(conn);
          return Promise.resolve(conn);
        },
      }),
      wake,
      vault,
    );
    rig.box.uids.push(
      { uid: 12, from: "bob@example.com", subject: "Raport" },
      { uid: 13, from: "ada@example.com", subject: "raport dobowy" },
      { uid: 14, from: "ada@example.com", subject: "RAPORT końcowy" },
    );
    await coordinator.poll(T0 + 15_000);
    const keys = store.listDeliveries("w_0123456789ab").map((item) =>
      item.eventKey
    );
    assert.deepEqual(keys, [
      "zoho:zoho:INBOX:5:13",
      "zoho:zoho:INBOX:5:14",
    ]);
    assert.equal(
      keys.some((key) => key.endsWith(":11") || key.endsWith(":12")),
      false,
    );
    assert.match(conns[1].commands.join("\n"), /UID SEARCH UID 12:\*/);
    await coordinator.flush(T0 + 15_000);
    await coordinator.flush(T0 + 15_000);
    const texts = wake.dispatched.map((payload) =>
      JSON.parse(payload).message.text as string
    );
    assert.match(texts[0], /:13/);
    assert.match(texts[1], /:14/);
    await coordinator.poll(T0 + 30_000);
    assert.equal(store.listDeliveries("w_0123456789ab").length, 2);

    rig.box.uidValidity = "8";
    rig.box.uidNext = 3;
    rig.box.uids = [{
      uid: 1,
      from: "ada@example.com",
      subject: "raport stary",
    }];
    await coordinator.poll(T0 + 45_000);
    assert.equal(store.listDeliveries("w_0123456789ab").length, 2);
    const watch = store.getWatch("w_0123456789ab");
    assert.match(watch?.continuity ?? "", /Przerwano ciągłość/);
    assert.equal(
      watch?.cursor?.kind === "mail" && watch.cursor.uidValidity,
      "8",
    );
    assert.equal(
      conns.at(-1)?.commands.some((line) => line.includes("UID SEARCH")),
      false,
    );
    assert.match(
      formatShow({ watch: watch!, pending: null }),
      /ciągłość: Przerwano ciągłość/,
    );
    store.close();
  } finally {
    await rig.home.cleanup();
  }
});
