import { UserError } from "../errors.ts";
import { type ByteConn, emailAddress, ImapClient } from "../imap.ts";
import { mailSummary } from "../notify.ts";
import type { SecretLoader } from "../secrets.ts";
import { IMAP_TIMEOUT_MS, PAGE_LIMIT } from "../schedule.ts";
import type {
  MailCursor,
  Observation,
  ObservedMessage,
  ZohoFilters,
} from "../types.ts";
import { SecretVault } from "../redact.ts";

const KEYS = [
  "ZOHO_MAIL_USER",
  "ZOHO_MAIL_APP_PASSWORD",
  "ZOHO_MAIL_IMAP_HOST",
];
export const DEFAULT_IMAP_HOST = "imappro.zoho.eu";

export function assertZohoHost(host: string): void {
  const name = host.toLowerCase().replace(/\.+$/, "");
  const allowed = name === "zoho.com" || name === "zoho.eu" ||
    name.endsWith(".zoho.com") ||
    name.endsWith(".zoho.eu");
  if (!allowed) {
    throw new UserError(
      "Host IMAP Zoho musi należeć do zoho.com albo zoho.eu.",
    );
  }
}

export async function connectZoho(host: string): Promise<ByteConn> {
  assertZohoHost(host);
  return await Deno.connectTls({ hostname: host, port: 993 });
}

export async function observeZoho(
  filters: ZohoFilters,
  cursor: MailCursor | null,
  deps: {
    secrets: SecretLoader;
    vault: SecretVault;
    connectImap?: (host: string) => Promise<ByteConn>;
    timeoutMs?: number;
    pageLimit?: number;
  },
): Promise<Observation> {
  let env: Record<string, string>;
  try {
    env = await deps.secrets.load(filters.secretProfile, KEYS);
  } catch (err) {
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof Error ? err.message : "Błąd sekretów.",
      ),
    };
  }
  for (const value of Object.values(env)) deps.vault.note(value);
  const user = env.ZOHO_MAIL_USER;
  const password = env.ZOHO_MAIL_APP_PASSWORD;
  if (!user || !password) {
    return {
      type: "error",
      message: "Profil Zoho nie zawiera użytkownika albo hasła aplikacji.",
    };
  }
  const host = env.ZOHO_MAIL_IMAP_HOST || DEFAULT_IMAP_HOST;
  if (!deps.connectImap) {
    try {
      assertZohoHost(host);
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Zły host IMAP.",
      };
    }
  }
  const connect = deps.connectImap ?? connectZoho;
  let conn: ByteConn;
  try {
    conn = await connect(host);
  } catch (err) {
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof Error ? err.message : "Błąd sieci IMAP.",
      ),
    };
  }
  try {
    return await session(
      filters,
      cursor,
      conn,
      user,
      password,
      deps.timeoutMs,
      deps.pageLimit,
    );
  } catch (err) {
    if (err instanceof UserError && err.message.startsWith("Logowanie IMAP")) {
      deps.secrets.invalidate?.(filters.secretProfile);
    }
    return {
      type: "error",
      message: deps.vault.redact(
        err instanceof UserError ? err.message : "Odczyt IMAP nie powiódł się.",
      ),
    };
  } finally {
    try {
      conn.close();
    } catch {
      /* already closed */
    }
  }
}

async function session(
  filters: ZohoFilters,
  cursor: MailCursor | null,
  conn: ByteConn,
  user: string,
  password: string,
  timeoutMs = IMAP_TIMEOUT_MS,
  pageLimit = PAGE_LIMIT,
): Promise<Observation> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      conn.close();
    } catch {
      /* closing unblocks the read */
    }
  }, timeoutMs);
  try {
    const client = new ImapClient(conn);
    await client.readGreeting();
    await client.login(user, password);
    const box = await client.examine(filters.folder);
    if (cursor && cursor.folder !== filters.folder) {
      await client.logout();
      return {
        type: "error",
        message: "Kursor dotyczy innego folderu. Odczyt został zatrzymany.",
      };
    }
    const baseline: MailCursor = {
      kind: "mail",
      folder: filters.folder,
      uidValidity: box.uidValidity,
      uid: Math.max(0, box.uidNext - 1),
    };
    if (!cursor) {
      await client.logout();
      return { type: "baseline", cursor: baseline };
    }
    if (cursor.uidValidity !== box.uidValidity) {
      await client.logout();
      return {
        type: "reset",
        cursor: baseline,
        note:
          `Przerwano ciągłość obserwacji: UIDVALIDITY folderu ${filters.folder} zmieniło się. Ustanowiono nowy punkt startowy i nie wczytano starej skrzynki jako nowych wiadomości.`,
      };
    }
    const uids = (await client.searchUids(cursor.uid)).slice(0, pageLimit);
    const headers = await client.fetchHeaders(uids);
    await client.logout();
    if (headers.length !== uids.length) {
      throw new UserError("Odczyt IMAP nie powiódł się.");
    }
    const messages: ObservedMessage[] = headers.map((header) => {
      const from = emailAddress(header.from);
      const next: MailCursor = {
        kind: "mail",
        folder: filters.folder,
        uidValidity: box.uidValidity,
        uid: header.uid,
      };
      return {
        key:
          `zoho:${filters.profile}:${filters.folder}:${box.uidValidity}:${header.uid}`,
        order: header.uid,
        summary: mailSummary(from, header.subject),
        url: null,
        from,
        subject: header.subject,
        topic: null,
        stream: null,
        cursorAfter: next,
      };
    });
    const end = messages.at(-1)?.cursorAfter ?? cursor;
    return { type: "messages", cursor: end, messages };
  } catch (err) {
    if (timedOut) throw new UserError("Przekroczono czas oczekiwania na IMAP.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
