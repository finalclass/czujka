import { iso } from "./clock.ts";
import { UserError } from "./errors.ts";
import { notification } from "./notify.ts";
import type {
  ResolveResult,
  SourcePort,
  WakeOutcome,
  WakePort,
} from "./ports.ts";
import { SecretVault } from "./redact.ts";
import { interpret } from "./rules.ts";
import { backoffMs, HEALTHY_INTERVAL_MS, MAX_PARALLEL } from "./schedule.ts";
import { type DeliveryDraft, Store } from "./store.ts";
import type { Delivery, DeliveryStatus, Watch } from "./types.ts";

export type WatchView = {
  watch: Watch;
  pending: Delivery | null;
};

export class Coordinator {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly store: Store,
    private readonly sources: SourcePort,
    private readonly wake: WakePort,
    private readonly vault: SecretVault,
  ) {}

  add(watch: Watch): Promise<Watch> {
    return this.exclusive(() => {
      this.store.insertWatch(watch);
      const saved = this.store.getWatch(watch.id);
      if (!saved) {
        throw new UserError("Zapis czujki nie jest widoczny po utrwaleniu.");
      }
      return saved;
    });
  }

  list(): Promise<WatchView[]> {
    return this.exclusive(() =>
      this.store.listWatches().map((watch) => this.view(watch))
    );
  }

  show(id: string): Promise<WatchView> {
    return this.exclusive(() => {
      const watch = this.store.getWatch(id);
      if (!watch) throw new UserError("Nie ma takiej czujki.");
      return this.view(watch);
    });
  }

  remove(id: string, now: number): Promise<number> {
    return this.exclusive(() => this.store.remove(id, iso(now)));
  }

  tick(now: number): Promise<void> {
    return this.exclusive(async () => {
      await this.pollInner(now);
      await this.flushInner(now);
    });
  }

  poll(now: number): Promise<void> {
    return this.exclusive(() => this.pollInner(now));
  }

  flush(now: number): Promise<void> {
    return this.exclusive(() => this.flushInner(now));
  }

  private async pollInner(now: number): Promise<void> {
    const due = this.store.due(now, MAX_PARALLEL);
    await Promise.all(due.map((watch) => this.check(watch, now)));
  }

  private async check(watch: Watch, now: number): Promise<void> {
    let observation;
    try {
      observation = await this.sources.observe(watch, now);
    } catch (err) {
      observation = {
        type: "error" as const,
        message: this.clean(err, "Błąd źródła."),
      };
    }
    const current = this.store.getWatch(watch.id);
    if (
      !current ||
      (current.phase !== "active" && current.phase !== "initializing")
    ) return;
    const update = interpret(current, observation, now);
    const drafts: DeliveryDraft[] = update.events.map((event) => ({
      key: event.key,
      summary: event.summary,
      url: event.url,
      text: notification({
        watchId: current.id,
        event: current.filters.event,
        eventKey: event.key,
        sourceUrl: event.url,
        detectedAt: update.lastCheckAt,
        summary: event.summary,
      }),
    }));
    this.store.apply(current.id, update, drafts);
  }

  private async flushInner(now: number): Promise<void> {
    const heads = this.store.heads(now, MAX_PARALLEL);
    await Promise.all(heads.map((delivery) => this.deliver(delivery, now)));
  }

  private async deliver(delivery: Delivery, now: number): Promise<void> {
    const watch = this.store.getWatch(delivery.watchId);
    if (!watch || watch.phase === "removed") return;
    let resolved: ResolveResult;
    try {
      resolved = await this.wake.resolve(watch.wakeTarget);
    } catch (err) {
      this.finish(delivery, watch, {
        type: "ambiguous",
        message: this.clean(err, "Nieznany wynik wybudzenia."),
      }, now);
      return;
    }
    if (resolved.type === "deferred") {
      this.finish(delivery, watch, resolved, now);
      return;
    }
    if (resolved.type === "error") {
      this.finish(delivery, watch, {
        type: delivery.status === "ambiguous" ? "ambiguous" : "error",
        message: resolved.message,
      }, now);
      return;
    }
    if (
      delivery.boundThreadId &&
      delivery.boundThreadId !== resolved.thread.threadId
    ) {
      this.finish(delivery, watch, {
        type: "error",
        message:
          "Cel wybudzenia wskazuje teraz inny wątek T3. Nie wysyłam tej samej komendy ponownie.",
      }, now);
      return;
    }
    let payload = delivery.payloadJson;
    if (!payload) {
      try {
        payload = this.wake.prepare(delivery, resolved.thread);
        this.store.savePayload(delivery.id, payload, resolved.thread.threadId);
      } catch (err) {
        this.finish(delivery, watch, {
          type: "error",
          message: this.clean(err, "Nie udało się przygotować komendy T3."),
        }, now);
        return;
      }
    }
    let outcome: WakeOutcome;
    try {
      outcome = await this.wake.dispatch(payload);
    } catch (err) {
      outcome = {
        type: "ambiguous",
        message: this.clean(err, "Nieznany wynik wybudzenia."),
      };
    }
    const fresh = this.store.getDelivery(delivery.id) ?? delivery;
    this.finish(fresh, watch, outcome, now);
  }

  private finish(
    delivery: Delivery,
    watch: Watch,
    outcome: WakeOutcome,
    now: number,
  ): void {
    const attempts = delivery.attempts + 1;
    let status: DeliveryStatus;
    if (outcome.type === "accepted") status = "accepted";
    else if (delivery.status === "ambiguous") status = "ambiguous";
    else if (outcome.type === "deferred") status = "deferred";
    else if (outcome.type === "ambiguous") status = "ambiguous";
    else status = "pending";
    const delay = status === "deferred"
      ? HEALTHY_INTERVAL_MS
      : backoffMs(attempts);
    this.store.settle({
      id: delivery.id,
      status,
      lastError: outcome.type === "accepted"
        ? null
        : this.vault.redact(outcome.message),
      attempts,
      nextAttemptAt: status === "accepted" ? null : iso(now + delay),
      acceptedAt: status === "accepted" ? iso(now) : null,
      completeWatchId: status === "accepted" && watch.mode === "once"
        ? watch.id
        : null,
      now: iso(now),
    });
  }

  private view(watch: Watch): WatchView {
    const pending =
      this.store.listDeliveries(watch.id).find((delivery) =>
        delivery.status === "pending" ||
        delivery.status === "deferred" ||
        delivery.status === "ambiguous"
      ) ?? null;
    return { watch, pending };
  }

  private clean(err: unknown, fallback: string): string {
    const message = err instanceof Error && err.message
      ? err.message
      : fallback;
    return this.vault.redact(message);
  }

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => {}, () => {});
    return run;
  }
}
