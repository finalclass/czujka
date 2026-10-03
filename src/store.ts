import { DatabaseSync } from "node:sqlite";
import { newDeliveryId } from "./config.ts";
import { UserError } from "./errors.ts";
import {
  type Cursor,
  cursorMatches,
  type Delivery,
  type DeliveryStatus,
  parseCursor,
  parseFilters,
  type Watch,
  type WatchUpdate,
} from "./types.ts";

export type DeliveryDraft = {
  key: string;
  summary: string;
  url: string | null;
  text: string;
};

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`zły zapis ${key}`);
  return value;
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`zły zapis ${key}`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`zły zapis ${key}`);
  }
  return value;
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Store {
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    const store = new Store(db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        phase TEXT NOT NULL,
        event TEXT NOT NULL,
        wake_target TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        cursor_json TEXT,
        continuity TEXT,
        last_check_at TEXT,
        next_check_at TEXT,
        last_error TEXT,
        failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        command_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_json TEXT,
        bound_thread_id TEXT,
        text TEXT NOT NULL,
        source_url TEXT,
        summary TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        accepted_at TEXT,
        UNIQUE (watch_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_watch ON deliveries(watch_id);
    `);
    const version = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'version'",
    ).get() as
      | Row
      | undefined;
    if (!version) {
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('version', '1')")
        .run();
    } else if (version.value !== "1") {
      throw new UserError("Nieobsługiwana wersja magazynu czujki.");
    }
  }

  insertWatch(watch: Watch): void {
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO watches (
          id, mode, phase, event, wake_target, filters_json, cursor_json, continuity,
          last_check_at, next_check_at, last_error, failures, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        watch.id,
        watch.mode,
        watch.phase,
        watch.filters.event,
        watch.wakeTarget,
        JSON.stringify(watch.filters),
        watch.cursor ? JSON.stringify(watch.cursor) : null,
        watch.continuity,
        watch.lastCheckAt,
        watch.nextCheckAt,
        watch.lastError,
        watch.failures,
        watch.createdAt,
        watch.updatedAt,
      );
    });
  }

  getWatch(id: string): Watch | null {
    const row = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.mapWatch(row) : null;
  }

  listWatches(): Watch[] {
    const rows = this.db.prepare(
      "SELECT * FROM watches ORDER BY created_at, id",
    ).all() as Row[];
    const watches: Watch[] = [];
    for (const row of rows) {
      try {
        watches.push(this.mapWatch(row));
      } catch (err) {
        const id = typeof row.id === "string" ? row.id : "?";
        console.error(
          `czujka: pomijam uszkodzony zapis ${id}: ${
            err instanceof Error ? err.message : "błąd"
          }`,
        );
      }
    }
    return watches;
  }

  due(nowMs: number, limit: number): Watch[] {
    return this.listWatches()
      .filter((watch) =>
        watch.phase === "active" || watch.phase === "initializing"
      )
      .filter((watch) =>
        !watch.nextCheckAt || Date.parse(watch.nextCheckAt) <= nowMs
      )
      .sort((a, b) =>
        (a.nextCheckAt ?? "").localeCompare(b.nextCheckAt ?? "") ||
        a.id.localeCompare(b.id)
      )
      .slice(0, limit);
  }

  apply(watchId: string, update: WatchUpdate, drafts: DeliveryDraft[]): void {
    if (drafts.length !== update.events.length) {
      throw new Error("lista dostaw nie zgadza się z wykrytymi zdarzeniami");
    }
    this.transaction(() => {
      const current = this.getWatch(watchId);
      if (!current) throw new UserError("Nie ma takiej czujki.");
      if (current.phase !== "active" && current.phase !== "initializing") {
        return;
      }
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        const event = update.events[i];
        if (draft.key !== event.key) throw new Error("kolejność dostaw");
        this.db.prepare(
          `INSERT OR IGNORE INTO deliveries (
            id, watch_id, event_key, command_id, message_id, text, source_url, summary,
            detected_at, status, attempts, next_attempt_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        ).run(
          newDeliveryId(),
          watchId,
          draft.key,
          crypto.randomUUID(),
          crypto.randomUUID(),
          draft.text,
          draft.url,
          draft.summary,
          update.lastCheckAt,
          update.lastCheckAt,
        );
      }
      this.db.prepare(
        `UPDATE watches SET
          phase = ?, cursor_json = ?, continuity = ?, last_check_at = ?, next_check_at = ?,
          last_error = ?, failures = ?, updated_at = ?
        WHERE id = ?`,
      ).run(
        update.phase,
        update.cursor ? JSON.stringify(update.cursor) : null,
        update.continuity,
        update.lastCheckAt,
        update.nextCheckAt,
        update.lastError,
        update.failures,
        update.lastCheckAt,
        watchId,
      );
    });
  }

  listDeliveries(watchId: string): Delivery[] {
    const rows = this.db.prepare(
      "SELECT * FROM deliveries WHERE watch_id = ? ORDER BY rowid",
    ).all(watchId) as Row[];
    return rows.map((row) => this.mapDelivery(row));
  }

  getDelivery(id: string): Delivery | null {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(
      id,
    ) as Row | undefined;
    return row ? this.mapDelivery(row) : null;
  }

  heads(nowMs: number, limit: number): Delivery[] {
    const rows = this.db.prepare(
      `SELECT d.* FROM deliveries d
       JOIN watches w ON w.id = d.watch_id
       WHERE d.status IN ('pending', 'deferred', 'ambiguous')
         AND w.phase != 'removed'
         AND d.rowid = (
           SELECT d2.rowid FROM deliveries d2
           WHERE d2.watch_id = d.watch_id
             AND d2.status IN ('pending', 'deferred', 'ambiguous')
           ORDER BY d2.rowid
           LIMIT 1
         )
       ORDER BY d.rowid`,
    ).all() as Row[];
    return rows
      .map((row) => this.mapDelivery(row))
      .filter((delivery) =>
        !delivery.nextAttemptAt || Date.parse(delivery.nextAttemptAt) <= nowMs
      )
      .slice(0, limit);
  }

  savePayload(id: string, payload: string, threadId: string): void {
    this.transaction(() => {
      const current = this.getDelivery(id);
      if (!current) throw new UserError("Nie ma takiej dostawy.");
      if (current.payloadJson) {
        if (
          current.payloadJson !== payload || current.boundThreadId !== threadId
        ) {
          throw new UserError(
            "Zapisana komenda T3 nie zgadza się z ponowieniem.",
          );
        }
        return;
      }
      this.db.prepare(
        "UPDATE deliveries SET payload_json = ?, bound_thread_id = ? WHERE id = ? AND payload_json IS NULL",
      ).run(payload, threadId, id);
    });
  }

  settle(input: {
    id: string;
    status: DeliveryStatus;
    lastError: string | null;
    attempts: number;
    nextAttemptAt: string | null;
    acceptedAt: string | null;
    completeWatchId: string | null;
    now: string;
  }): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE deliveries SET
          status = ?, last_error = ?, attempts = ?, next_attempt_at = ?, accepted_at = ?
        WHERE id = ?`,
      ).run(
        input.status,
        input.lastError,
        input.attempts,
        input.nextAttemptAt,
        input.acceptedAt,
        input.id,
      );
      if (input.completeWatchId) {
        this.db.prepare(
          `UPDATE deliveries SET status = 'cancelled', next_attempt_at = NULL
           WHERE watch_id = ? AND id != ? AND status IN ('pending', 'deferred', 'ambiguous')`,
        ).run(input.completeWatchId, input.id);
        this.db.prepare(
          `UPDATE watches SET phase = 'completed', next_check_at = NULL, updated_at = ?
           WHERE id = ? AND phase != 'removed'`,
        ).run(input.now, input.completeWatchId);
      }
    });
  }

  remove(id: string, now: string): number {
    return this.transaction(() => {
      const watch = this.getWatch(id);
      if (!watch) throw new UserError("Nie ma takiej czujki.");
      if (watch.phase === "removed") {
        throw new UserError("Czujka jest już usunięta.");
      }
      const result = this.db.prepare(
        `UPDATE deliveries SET status = 'cancelled', next_attempt_at = NULL
         WHERE watch_id = ? AND status IN ('pending', 'deferred', 'ambiguous')`,
      ).run(id);
      this.db.prepare(
        `UPDATE watches SET phase = 'removed', next_check_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, id);
      return Number(result.changes);
    });
  }

  private mapWatch(row: Row): Watch {
    const filters = parseFilters(JSON.parse(text(row, "filters_json")));
    const rawCursor = textOrNull(row, "cursor_json");
    let cursor: Cursor | null = null;
    if (rawCursor) {
      cursor = parseCursor(JSON.parse(rawCursor));
      if (!cursorMatches(filters.event, cursor)) {
        throw new Error("kursor nie pasuje do zdarzenia");
      }
    }
    const mode = text(row, "mode");
    const phase = text(row, "phase");
    if (mode !== "once" && mode !== "on") throw new Error("tryb");
    if (
      phase !== "initializing" && phase !== "active" && phase !== "holding" &&
      phase !== "completed" && phase !== "removed"
    ) throw new Error("stan");
    return {
      id: text(row, "id"),
      mode,
      phase,
      wakeTarget: text(row, "wake_target"),
      filters,
      cursor,
      continuity: textOrNull(row, "continuity"),
      lastCheckAt: textOrNull(row, "last_check_at"),
      nextCheckAt: textOrNull(row, "next_check_at"),
      lastError: textOrNull(row, "last_error"),
      failures: integer(row, "failures"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  private mapDelivery(row: Row): Delivery {
    const status = text(row, "status");
    if (
      status !== "pending" && status !== "deferred" && status !== "accepted" &&
      status !== "cancelled" && status !== "ambiguous"
    ) throw new Error("status dostawy");
    return {
      id: text(row, "id"),
      watchId: text(row, "watch_id"),
      eventKey: text(row, "event_key"),
      commandId: text(row, "command_id"),
      messageId: text(row, "message_id"),
      payloadJson: textOrNull(row, "payload_json"),
      boundThreadId: textOrNull(row, "bound_thread_id"),
      text: text(row, "text"),
      sourceUrl: textOrNull(row, "source_url"),
      summary: text(row, "summary"),
      detectedAt: text(row, "detected_at"),
      status,
      attempts: integer(row, "attempts"),
      nextAttemptAt: textOrNull(row, "next_attempt_at"),
      lastError: textOrNull(row, "last_error"),
      acceptedAt: textOrNull(row, "accepted_at"),
    };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      throw err;
    }
  }
}
