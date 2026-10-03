export const EVENTS = [
  "forgejo-issue-closed",
  "forgejo-issue-commented",
  "forgejo-pull-activity",
  "zoho-mail-received",
  "zulip-message-received",
] as const;

export type EventName = typeof EVENTS[number];

export type Mode = "once" | "on";

export type Phase =
  | "initializing"
  | "active"
  | "holding"
  | "completed"
  | "removed";

export type DeliveryStatus =
  | "pending"
  | "deferred"
  | "accepted"
  | "cancelled"
  | "ambiguous";

export type ForgejoTarget = {
  origin: string;
  owner: string;
  repo: string;
  issue: number;
  profile: string;
};

export type ForgejoFilters = ForgejoTarget & {
  event: "forgejo-issue-closed";
};

export type ForgejoCommentFilters = ForgejoTarget & {
  event: "forgejo-issue-commented";
};

export type ForgejoPullFilters = {
  event: "forgejo-pull-activity";
  origin: string;
  owner: string;
  repo: string;
  pull: number;
  profile: string;
};

export type ZohoFilters = {
  event: "zoho-mail-received";
  profile: string;
  secretProfile: string;
  folder: string;
  from: string | null;
  subjectContains: string | null;
};

export type ZulipFilters = {
  event: "zulip-message-received";
  profile: string;
  secretProfile: string;
  stream: string;
  topic: string | null;
};

export type Filters =
  | ForgejoFilters
  | ForgejoCommentFilters
  | ForgejoPullFilters
  | ZohoFilters
  | ZulipFilters;

export type ForgejoCursor = {
  kind: "forgejo";
  state: "open" | "closed";
  transition: number;
};

export type ForgejoCommentCursor = {
  kind: "forgejo-comment";
  lastId: number;
};

export type ForgejoPullCursor = {
  kind: "forgejo-pull";
  lastId: number;
  mergePendingClose: boolean;
  merged: boolean;
};

export type MailCursor = {
  kind: "mail";
  folder: string;
  uidValidity: string;
  uid: number;
};

export type ZulipCursor = {
  kind: "zulip";
  site: string;
  streamId: number;
  lastId: number;
};

export type Cursor =
  | ForgejoCursor
  | ForgejoCommentCursor
  | ForgejoPullCursor
  | MailCursor
  | ZulipCursor;

export type Watch = {
  id: string;
  mode: Mode;
  phase: Phase;
  wakeTarget: string;
  filters: Filters;
  cursor: Cursor | null;
  continuity: string | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  failures: number;
  createdAt: string;
  updatedAt: string;
};

export type Delivery = {
  id: string;
  watchId: string;
  eventKey: string;
  commandId: string;
  messageId: string;
  payloadJson: string | null;
  boundThreadId: string | null;
  text: string;
  sourceUrl: string | null;
  summary: string;
  detectedAt: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  acceptedAt: string | null;
};

export type PlannedEvent = {
  key: string;
  summary: string;
  url: string | null;
};

export type ObservedMessage = {
  key: string;
  order: number;
  summary: string;
  url: string | null;
  from: string | null;
  subject: string | null;
  topic: string | null;
  stream: string | null;
  cursorAfter: Cursor;
};

export type Observation =
  | { type: "forgejo"; state: "open" | "closed"; number: number; url: string }
  | { type: "baseline"; cursor: Cursor }
  | { type: "reset"; cursor: Cursor; note: string }
  | {
    type: "messages";
    cursor: Cursor;
    note?: string;
    messages: ObservedMessage[];
  }
  | { type: "error"; message: string; retryAfterMs?: number };

export type WatchUpdate = {
  phase: Phase;
  cursor: Cursor | null;
  continuity: string | null;
  lastError: string | null;
  failures: number;
  nextCheckAt: string | null;
  lastCheckAt: string;
  events: PlannedEvent[];
};

export function eventOf(filters: Filters): EventName {
  return filters.event;
}

export function parseFilters(value: unknown): Filters {
  if (!value || typeof value !== "object") throw new Error("filtry");
  const row = value as Record<string, unknown>;
  if (
    row.event === "forgejo-issue-closed" ||
    row.event === "forgejo-issue-commented"
  ) {
    const target = forgejoTarget(row);
    if (!target) throw new Error("filtry forgejo");
    return { event: row.event, ...target };
  }
  if (row.event === "forgejo-pull-activity") {
    const pull = forgejoPull(row);
    if (!pull) throw new Error("filtry forgejo");
    return pull;
  }
  if (row.event === "zoho-mail-received") {
    if (
      typeof row.profile !== "string" ||
      typeof row.secretProfile !== "string" ||
      typeof row.folder !== "string" ||
      !(row.from === null || typeof row.from === "string") ||
      !(row.subjectContains === null || typeof row.subjectContains === "string")
    ) throw new Error("filtry zoho");
    return {
      event: "zoho-mail-received",
      profile: row.profile,
      secretProfile: row.secretProfile,
      folder: row.folder,
      from: row.from as string | null,
      subjectContains: row.subjectContains as string | null,
    };
  }
  if (row.event === "zulip-message-received") {
    if (
      typeof row.profile !== "string" ||
      typeof row.secretProfile !== "string" ||
      typeof row.stream !== "string" ||
      !(row.topic === null || typeof row.topic === "string")
    ) throw new Error("filtry zulip");
    return {
      event: "zulip-message-received",
      profile: row.profile,
      secretProfile: row.secretProfile,
      stream: row.stream,
      topic: row.topic as string | null,
    };
  }
  throw new Error("filtry");
}

export function parseCursor(value: unknown): Cursor {
  if (!value || typeof value !== "object") throw new Error("kursor");
  const row = value as Record<string, unknown>;
  if (
    row.kind === "forgejo" &&
    (row.state === "open" || row.state === "closed") &&
    Number.isInteger(row.transition) &&
    (row.transition as number) >= 0
  ) {
    return {
      kind: "forgejo",
      state: row.state,
      transition: row.transition as number,
    };
  }
  if (
    row.kind === "forgejo-comment" &&
    Number.isInteger(row.lastId) &&
    (row.lastId as number) >= 0
  ) {
    return { kind: "forgejo-comment", lastId: row.lastId as number };
  }
  if (
    row.kind === "forgejo-pull" &&
    Number.isInteger(row.lastId) &&
    (row.lastId as number) >= 0 &&
    typeof row.mergePendingClose === "boolean" &&
    typeof row.merged === "boolean"
  ) {
    return {
      kind: "forgejo-pull",
      lastId: row.lastId as number,
      mergePendingClose: row.mergePendingClose,
      merged: row.merged,
    };
  }
  if (
    row.kind === "mail" &&
    typeof row.folder === "string" &&
    typeof row.uidValidity === "string" &&
    Number.isInteger(row.uid) &&
    (row.uid as number) >= 0
  ) {
    return {
      kind: "mail",
      folder: row.folder,
      uidValidity: row.uidValidity,
      uid: row.uid as number,
    };
  }
  if (
    row.kind === "zulip" &&
    typeof row.site === "string" &&
    Number.isInteger(row.streamId) &&
    Number.isInteger(row.lastId) &&
    (row.lastId as number) >= 0 &&
    (row.streamId as number) > 0
  ) {
    return {
      kind: "zulip",
      site: row.site,
      streamId: row.streamId as number,
      lastId: row.lastId as number,
    };
  }
  throw new Error("kursor");
}

export function cursorMatches(event: EventName, cursor: Cursor): boolean {
  switch (event) {
    case "forgejo-issue-closed":
      return cursor.kind === "forgejo";
    case "forgejo-issue-commented":
      return cursor.kind === "forgejo-comment";
    case "forgejo-pull-activity":
      return cursor.kind === "forgejo-pull";
    case "zoho-mail-received":
      return cursor.kind === "mail";
    case "zulip-message-received":
      return cursor.kind === "zulip";
  }
}

function forgejoTarget(row: Record<string, unknown>): ForgejoTarget | null {
  if (
    typeof row.origin !== "string" ||
    typeof row.owner !== "string" ||
    typeof row.repo !== "string" ||
    typeof row.profile !== "string" ||
    !Number.isInteger(row.issue)
  ) return null;
  return {
    origin: row.origin,
    owner: row.owner,
    repo: row.repo,
    issue: row.issue as number,
    profile: row.profile,
  };
}

function forgejoPull(
  row: Record<string, unknown>,
): ForgejoPullFilters | null {
  if (
    typeof row.origin !== "string" ||
    typeof row.owner !== "string" ||
    typeof row.repo !== "string" ||
    typeof row.profile !== "string" ||
    !Number.isInteger(row.pull) ||
    (row.pull as number) <= 0
  ) return null;
  return {
    event: "forgejo-pull-activity",
    origin: row.origin,
    owner: row.owner,
    repo: row.repo,
    pull: row.pull as number,
    profile: row.profile,
  };
}
