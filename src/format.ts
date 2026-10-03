import type { WatchView } from "./coordinator.ts";
import type { Delivery, Phase, Watch } from "./types.ts";

const PHASES: Record<Phase, string> = {
  initializing: "inicjalizacja",
  active: "aktywna",
  holding: "oczekuje na dostawę",
  completed: "zakończona",
  removed: "usunięta",
};

const DELIVERY: Record<Delivery["status"], string> = {
  pending: "oczekuje",
  deferred: "odroczona",
  accepted: "przyjęta",
  cancelled: "anulowana",
  ambiguous: "niejednoznaczna",
};

function dash(value: string | null): string {
  return value ?? "—";
}

function target(watch: Watch): string {
  return watch.wakeTarget;
}

export function formatWatch(view: WatchView): string {
  const { watch, pending } = view;
  const lines = [
    `${watch.id}  ${
      PHASES[watch.phase]
    }  ${watch.mode}  ${watch.filters.event}  cel=${target(watch)}`,
    `  ostatnie sprawdzenie: ${dash(watch.lastCheckAt)}`,
    `  kolejne sprawdzenie: ${dash(watch.nextCheckAt)}`,
    `  ostatni błąd: ${dash(pending?.lastError ?? watch.lastError)}`,
    `  oczekująca dostawa: ${
      pending ? `${pending.id} (${DELIVERY[pending.status]})` : "—"
    }`,
  ];
  if (watch.continuity) lines.push(`  ciągłość: ${watch.continuity}`);
  return lines.join("\n");
}

export function formatShow(view: WatchView): string {
  const { watch, pending } = view;
  const lines = [
    formatWatch(view),
    `  utworzono: ${watch.createdAt}`,
    `  filtry: ${JSON.stringify(watch.filters)}`,
    `  kursor: ${watch.cursor ? JSON.stringify(watch.cursor) : "—"}`,
    `  błąd źródła: ${dash(watch.lastError)}`,
  ];
  if (pending) {
    lines.push(
      `  dostawa: ${pending.id} ${
        DELIVERY[pending.status]
      } zdarzenie=${pending.eventKey}`,
    );
    lines.push(`  wykryto: ${pending.detectedAt} próby=${pending.attempts}`);
    if (pending.boundThreadId) {
      lines.push(`  wątek T3: ${pending.boundThreadId}`);
    }
    if (pending.lastError) lines.push(`  błąd dostawy: ${pending.lastError}`);
  }
  return lines.join("\n");
}

export function formatList(views: WatchView[]): string {
  if (views.length === 0) return "Brak czujek.";
  return views.map((view) => formatWatch(view)).join("\n\n");
}
