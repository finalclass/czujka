import { UserError } from "./errors.ts";

export interface ByteConn {
  read(buffer: Uint8Array): Promise<number | null>;
  write(buffer: Uint8Array): Promise<number>;
  close(): void;
}

export type MailboxInfo = {
  uidValidity: string;
  uidNext: number;
};

export type MailHeader = {
  uid: number;
  from: string;
  subject: string;
  messageId: string;
};

export function quoteImap(value: string): string {
  if (hasControl(value)) {
    throw new UserError("Nazwa folderu IMAP zawiera niedozwolony znak.");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function decodeMimeWords(value: string): string {
  const folded = value.replace(/\?=\s+=\?/g, "?==?");
  return folded.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_all, charset: string, encoding: string, data: string) => {
      const bytes = encoding.toUpperCase() === "B"
        ? base64Bytes(data)
        : qBytes(data);
      const label = charset.toLowerCase();
      const decoder = label === "iso-8859-1" || label === "latin1"
        ? "iso-8859-1"
        : "utf-8";
      try {
        return new TextDecoder(decoder, { fatal: false }).decode(bytes);
      } catch {
        return "";
      }
    },
  );
}

export function emailAddress(from: string): string {
  const decoded = decodeMimeWords(from);
  const angle = /<([^>]+)>/.exec(decoded);
  const raw = (angle?.[1] ?? decoded).trim();
  const match = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(raw);
  return match ? match[0].toLowerCase() : "";
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function qBytes(data: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    if (char === "_") bytes.push(0x20);
    else if (
      char === "=" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))
    ) {
      bytes.push(Number.parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(char.charCodeAt(0));
  }
  return new Uint8Array(bytes);
}

export class ImapClient {
  private tag = 0;
  private buffer = new Uint8Array(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly encoder = new TextEncoder();

  constructor(private readonly conn: ByteConn) {}

  async readGreeting(): Promise<void> {
    const line = await this.readLogicalLine();
    if (!/\bOK\b/i.test(line)) {
      throw new UserError("Serwer IMAP nie przywitał połączenia.");
    }
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(
      `LOGIN ${quoteImap(user)} ${quoteImap(password)}`,
      "Logowanie IMAP nie powiodło się.",
    );
  }

  async examine(folder: string): Promise<MailboxInfo> {
    const lines = await this.command(
      `EXAMINE ${quoteImap(folder)}`,
      "Nie można otworzyć folderu IMAP.",
    );
    const validity = lines.join("\n").match(/\[UIDVALIDITY ([0-9]+)\]/);
    const next = lines.join("\n").match(/\[UIDNEXT ([0-9]+)\]/);
    if (!validity || !next) {
      throw new UserError("Serwer IMAP nie podał UIDVALIDITY albo UIDNEXT.");
    }
    const uidNext = Number(next[1]);
    if (!Number.isSafeInteger(uidNext) || uidNext < 1) {
      throw new UserError("Serwer IMAP podał nieprawidłowy UIDNEXT.");
    }
    return { uidValidity: validity[1], uidNext };
  }

  async searchUids(afterUid: number): Promise<number[]> {
    const lines = await this.command(
      `UID SEARCH UID ${afterUid + 1}:*`,
      "Odczyt IMAP nie powiódł się.",
    );
    const uids: number[] = [];
    for (const line of lines) {
      if (!/^\* SEARCH\b/i.test(line)) continue;
      for (const token of line.replace(/^\* SEARCH\s*/i, "").split(/\s+/)) {
        if (!/^[0-9]+$/.test(token)) continue;
        const uid = Number(token);
        if (Number.isSafeInteger(uid) && uid > afterUid) uids.push(uid);
      }
    }
    return [...new Set(uids)].sort((a, b) => a - b);
  }

  async fetchHeaders(uids: number[]): Promise<MailHeader[]> {
    if (uids.length === 0) return [];
    const lines = await this.command(
      `UID FETCH ${
        uids.join(",")
      } (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`,
      "Odczyt IMAP nie powiódł się.",
    );
    const headers: MailHeader[] = [];
    for (const line of lines) {
      if (!/\bFETCH\b/.test(line)) continue;
      const uidMatch = /\bUID ([0-9]+)/.exec(line);
      if (!uidMatch) continue;
      const uid = Number(uidMatch[1]);
      headers.push({
        uid,
        from: headerValue(line, "from"),
        subject: decodeMimeWords(headerValue(line, "subject")),
        messageId: headerValue(line, "message-id").replace(/^<|>$/g, ""),
      });
    }
    headers.sort((a, b) => a.uid - b.uid);
    return headers;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT", "Odczyt IMAP nie powiódł się.");
    } catch {
      /* the server may close first */
    }
  }

  private async command(body: string, failure: string): Promise<string[]> {
    const tag = `C${(++this.tag).toString().padStart(4, "0")}`;
    await this.send(`${tag} ${body}`);
    const lines: string[] = [];
    while (true) {
      const line = await this.readLogicalLine();
      if (line.startsWith("+")) continue;
      if (line.startsWith(`${tag} `)) {
        if (line.slice(tag.length + 1).toUpperCase().startsWith("OK")) {
          return lines;
        }
        throw new UserError(failure);
      }
      lines.push(line);
    }
  }

  private async send(line: string): Promise<void> {
    const data = this.encoder.encode(`${line}\r\n`);
    let offset = 0;
    while (offset < data.length) {
      const wrote = await this.conn.write(data.subarray(offset));
      if (wrote <= 0) throw new UserError("Połączenie IMAP zostało zamknięte.");
      offset += wrote;
    }
  }

  private async readLogicalLine(): Promise<string> {
    let line = await this.readRawLine();
    while (true) {
      const match = /\{(\d+)\}$/.exec(line);
      if (!match) return line;
      const count = Number(match[1]);
      if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
        throw new UserError("Odczyt IMAP nie powiódł się.");
      }
      const literal = await this.readExact(count);
      line = line.slice(0, match.index) + "\n" + literal +
        await this.readRawLine();
    }
  }

  private async readRawLine(): Promise<string> {
    while (true) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) {
        await this.pull(this.buffer.length + 1);
        continue;
      }
      const slice = this.buffer.subarray(0, nl + 1);
      this.buffer = this.buffer.slice(nl + 1);
      return this.decoder.decode(slice).replace(/\r?\n$/, "");
    }
  }

  private async readExact(count: number): Promise<string> {
    await this.pull(count);
    const slice = this.buffer.subarray(0, count);
    this.buffer = this.buffer.slice(count);
    return this.decoder.decode(slice);
  }

  private async pull(min: number): Promise<void> {
    while (this.buffer.length < min) {
      const chunk = new Uint8Array(8192);
      const n = await this.conn.read(chunk);
      if (n === null || n <= 0) {
        throw new UserError("Połączenie IMAP zostało zamknięte.");
      }
      const piece = chunk.subarray(0, n);
      const merged = new Uint8Array(this.buffer.length + piece.length);
      merged.set(this.buffer);
      merged.set(piece, this.buffer.length);
      this.buffer = merged;
    }
  }
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function headerValue(block: string, name: string): string {
  const match = new RegExp(`(?:^|[\\r\\n])${name}:[ \\t]*([^\\r\\n]*)`, "i")
    .exec(block);
  return match?.[1]?.trim() ?? "";
}
