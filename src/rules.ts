import { iso } from "./clock.ts";
import { backoffMs, HEALTHY_INTERVAL_MS } from "./schedule.ts";
import {
  type Cursor,
  cursorMatches,
  type Observation,
  type ObservedMessage,
  type PlannedEvent,
  type Watch,
  type WatchUpdate,
} from "./types.ts";

function fail(
  watch: Watch,
  now: number,
  message: string,
  retryAfterMs?: number,
): WatchUpdate {
  const failures = watch.failures + 1;
  return {
    phase: watch.phase,
    cursor: watch.cursor,
    continuity: watch.continuity,
    lastError: message,
    failures,
    nextCheckAt: iso(now + backoffMs(failures, retryAfterMs)),
    lastCheckAt: iso(now),
    events: [],
  };
}

function schedule(now: number): string {
  return iso(now + HEALTHY_INTERVAL_MS);
}

function base(
  watch: Watch,
  now: number,
  extra: Partial<WatchUpdate> & Pick<WatchUpdate, "phase" | "cursor">,
): WatchUpdate {
  return {
    continuity: watch.continuity,
    lastError: null,
    failures: 0,
    nextCheckAt: extra.phase === "holding" || extra.phase === "completed" ||
        extra.phase === "removed"
      ? null
      : schedule(now),
    lastCheckAt: iso(now),
    events: [],
    ...extra,
  };
}

export function interpret(
  watch: Watch,
  observation: Observation,
  now: number,
): WatchUpdate {
  if (
    watch.phase === "removed" || watch.phase === "completed" ||
    watch.phase === "holding"
  ) {
    return {
      phase: watch.phase,
      cursor: watch.cursor,
      continuity: watch.continuity,
      lastError: watch.lastError,
      failures: watch.failures,
      nextCheckAt: null,
      lastCheckAt: watch.lastCheckAt ?? iso(now),
      events: [],
    };
  }
  if (observation.type === "error") {
    return fail(watch, now, observation.message, observation.retryAfterMs);
  }
  if (watch.filters.event === "forgejo-issue-closed") {
    if (observation.type !== "forgejo") {
      return fail(
        watch,
        now,
        "Źródło Forgejo zwróciło niepasującą obserwację.",
      );
    }
    return interpretForgejo(watch, observation, now);
  }
  return interpretMessages(watch, observation, now);
}

function interpretForgejo(
  watch: Watch,
  observation: Extract<Observation, { type: "forgejo" }>,
  now: number,
): WatchUpdate {
  const filters = watch.filters;
  if (filters.event !== "forgejo-issue-closed") {
    return fail(watch, now, "Niespójne filtry Forgejo.");
  }
  if (observation.number !== filters.issue) {
    return fail(
      watch,
      now,
      "Odpowiedź dotyczy innego zgłoszenia. Stan nie został zmieniony.",
    );
  }
  const previous = watch.cursor?.kind === "forgejo" ? watch.cursor : null;
  const transition = previous?.transition ?? 0;
  if (observation.state === "open") {
    return base(watch, now, {
      phase: "active",
      cursor: { kind: "forgejo", state: "open", transition },
    });
  }
  const firstLook = previous === null;
  const becameClosed = previous?.state === "open";
  const fire = watch.mode === "once" ? firstLook || becameClosed : becameClosed;
  if (!fire) {
    return base(watch, now, {
      phase: "active",
      cursor: { kind: "forgejo", state: "closed", transition },
    });
  }
  const nextTransition = transition + 1;
  const key =
    `forgejo:${filters.origin}:${filters.owner}/${filters.repo}#${filters.issue}:close:${nextTransition}`;
  return base(watch, now, {
    phase: watch.mode === "once" ? "holding" : "active",
    cursor: { kind: "forgejo", state: "closed", transition: nextTransition },
    events: [{
      key,
      summary: `Zgłoszenie #${filters.issue} jest zamknięte.`,
      url: observation.url,
    }],
  });
}

function interpretMessages(
  watch: Watch,
  observation: Observation,
  now: number,
): WatchUpdate {
  if (observation.type === "error" || observation.type === "forgejo") {
    return fail(watch, now, "Niepasująca obserwacja wiadomości.");
  }
  if (observation.type === "baseline") {
    if (watch.cursor) {
      return fail(
        watch,
        now,
        "Punkt startowy jest już zapisany. Nie ustanawiam go ponownie.",
      );
    }
    if (!cursorMatches(watch.filters.event, observation.cursor)) {
      return fail(watch, now, "Punkt startowy ma niepasujący kursor.");
    }
    return base(watch, now, {
      phase: "active",
      cursor: observation.cursor,
    });
  }
  if (observation.type === "reset") {
    if (!cursorMatches(watch.filters.event, observation.cursor)) {
      return fail(watch, now, "Nowy punkt startowy ma niepasujący kursor.");
    }
    return base(watch, now, {
      phase: "active",
      cursor: observation.cursor,
      continuity: observation.note,
    });
  }
  if (!watch.cursor) {
    return fail(
      watch,
      now,
      "Odmowa odczytu przed zapisaniem punktu startowego. Historia nie została wczytana.",
    );
  }
  if (!cursorMatches(watch.filters.event, observation.cursor)) {
    return fail(watch, now, "Kursor wiadomości nie pasuje do źródła.");
  }
  const ordered = [...observation.messages].sort((a, b) =>
    a.order - b.order || a.key.localeCompare(b.key)
  );
  const events: PlannedEvent[] = [];
  let cursor: Cursor = watch.cursor;
  for (const message of ordered) {
    if (!cursorMatches(watch.filters.event, message.cursorAfter)) {
      return fail(
        watch,
        now,
        "Wiadomość ma niepasujący kursor. Nic nie zostało przesunięte.",
      );
    }
    cursor = message.cursorAfter;
    if (!matches(watch, message)) continue;
    events.push({
      key: message.key,
      summary: message.summary,
      url: message.url,
    });
    if (watch.mode === "once") {
      return base(watch, now, {
        phase: "holding",
        cursor,
        continuity: observation.note ?? watch.continuity,
        events,
      });
    }
  }
  if (ordered.length === 0) cursor = observation.cursor;
  return base(watch, now, {
    phase: "active",
    cursor,
    continuity: observation.note ?? watch.continuity,
    events,
  });
}

function matches(watch: Watch, message: ObservedMessage): boolean {
  const filters = watch.filters;
  if (filters.event === "zoho-mail-received") {
    if (filters.from && (message.from ?? "").toLowerCase() !== filters.from) {
      return false;
    }
    if (filters.subjectContains) {
      const subject = message.subject ?? "";
      if (
        !subject.toLowerCase().includes(filters.subjectContains.toLowerCase())
      ) return false;
    }
    return true;
  }
  if (filters.event === "zulip-message-received") {
    if (message.stream !== filters.stream) return false;
    if (filters.topic !== null && message.topic !== filters.topic) return false;
    return true;
  }
  return filters.event === "forgejo-issue-commented" ||
    filters.event === "forgejo-pull-activity";
}
