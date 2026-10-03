import { UserError } from "./errors.ts";
import { type EventName, EVENTS, type Mode } from "./types.ts";

const KNOWN_FLAGS = new Set([
  "once",
  "on",
  "wake-up",
  "forgejo-url",
  "forgejo-repo",
  "forgejo-issue",
  "forgejo-pull",
  "zoho-profile",
  "mail-folder",
  "mail-from",
  "mail-subject-contains",
  "zulip-profile",
  "zulip-stream",
  "zulip-topic",
  "help",
]);

const COMMANDS = new Set([
  "daemon",
  "list",
  "show",
  "remove",
  "status",
  "help",
]);

export type Command =
  | { kind: "help" }
  | { kind: "daemon" }
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "show"; id: string }
  | { kind: "remove"; id: string }
  | {
    kind: "add";
    mode: Mode;
    event: EventName;
    wakeTarget: string;
    flags: Record<string, string>;
  };

export const HELP = `czujka — obserwacja zdarzeń i wybudzanie sesji T3

  czujka daemon
  czujka --once=ZDARZENIE --wake-up=SESJA [filtry]
  czujka --on=ZDARZENIE --wake-up=SESJA [filtry]
  czujka list
  czujka show WATCH_ID
  czujka remove WATCH_ID
  czujka status

Zdarzenia: forgejo-issue-closed, forgejo-issue-commented, forgejo-pull-activity, zoho-mail-received, zulip-message-received.
Dokładnie jeden tryb. Komentarz pod zgłoszeniem przyjmuje tylko --once. Nieznane flagi są odrzucane.
`;

function rejectControls(value: string, label: string): void {
  if (value.length > 500) throw new UserError(`${label} jest za długie.`);
  if (hasControl(value)) {
    throw new UserError(`${label} zawiera niedozwolony znak.`);
  }
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function parse(argv: string[]): Command {
  if (
    argv.length === 1 &&
    (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help")
  ) {
    return { kind: "help" };
  }
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      throw new UserError("Pomoc jest osobnym wywołaniem: czujka --help");
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    if (!body) throw new UserError("Pusta flaga.");
    let name: string;
    let value: string;
    const eq = body.indexOf("=");
    if (eq >= 0) {
      name = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      name = body;
      value = argv[++i];
    } else {
      throw new UserError(`Flaga --${body} wymaga wartości.`);
    }
    if (!KNOWN_FLAGS.has(name)) {
      throw new UserError(`Nieznana flaga --${name}.`);
    }
    if (flags.has(name)) {
      throw new UserError(`Flaga --${name} podana drugi raz.`);
    }
    if (!value) throw new UserError(`Flaga --${name} wymaga wartości.`);
    rejectControls(value, `--${name}`);
    flags.set(name, value);
  }

  const command = positionals[0];
  const hasOnce = flags.has("once");
  const hasOn = flags.has("on");
  if (command && COMMANDS.has(command)) {
    if (hasOnce || hasOn || flags.size > 0) {
      throw new UserError("Podaj dokładnie jeden tryb.");
    }
    if (command === "help") return { kind: "help" };
    if (command === "daemon" || command === "list" || command === "status") {
      if (positionals.length !== 1) {
        throw new UserError(`Polecenie ${command} nie przyjmuje argumentów.`);
      }
      return { kind: command };
    }
    if (positionals.length !== 2) {
      throw new UserError(
        `Polecenie ${command} wymaga jednego identyfikatora czujki.`,
      );
    }
    const id = positionals[1];
    if (!/^w_[0-9a-f]{12}$/.test(id)) {
      throw new UserError("Nieprawidłowy identyfikator czujki.");
    }
    return command === "show" ? { kind: "show", id } : { kind: "remove", id };
  }
  if (positionals.length > 0) {
    throw new UserError(`Nieznane polecenie „${positionals[0]}”.`);
  }
  if (hasOnce === hasOn) {
    throw new UserError("Podaj dokładnie jeden tryb: --once albo --on.");
  }
  const mode: Mode = hasOnce ? "once" : "on";
  const eventName = flags.get(mode)!;
  if (!EVENTS.includes(eventName as EventName)) {
    throw new UserError(`Nieznane zdarzenie „${eventName}”.`);
  }
  const wakeTarget = flags.get("wake-up");
  if (!wakeTarget) {
    throw new UserError(
      "Brak --wake-up=SESJA. Czujka nie tworzy nowej rozmowy.",
    );
  }
  if (/\s/.test(wakeTarget)) {
    throw new UserError("Identyfikator sesji nie może zawierać odstępu.");
  }
  const rest: Record<string, string> = {};
  for (const [key, value] of flags) {
    if (key === "once" || key === "on" || key === "wake-up") continue;
    rest[key] = value;
  }
  assertFlagsForEvent(eventName as EventName, rest);
  if (eventName === "forgejo-issue-commented" && mode !== "once") {
    throw new UserError(
      "Czujka komentarza jest jednorazowa. Użyj --once=forgejo-issue-commented.",
    );
  }
  return {
    kind: "add",
    mode,
    event: eventName as EventName,
    wakeTarget,
    flags: rest,
  };
}

const EVENT_FLAGS: Record<EventName, readonly string[]> = {
  "forgejo-issue-closed": ["forgejo-url", "forgejo-repo", "forgejo-issue"],
  "forgejo-issue-commented": ["forgejo-url", "forgejo-repo", "forgejo-issue"],
  "forgejo-pull-activity": ["forgejo-url", "forgejo-repo", "forgejo-pull"],
  "zoho-mail-received": [
    "zoho-profile",
    "mail-folder",
    "mail-from",
    "mail-subject-contains",
  ],
  "zulip-message-received": ["zulip-profile", "zulip-stream", "zulip-topic"],
};

function assertFlagsForEvent(
  event: EventName,
  flags: Record<string, string>,
): void {
  const allowed = new Set(EVENT_FLAGS[event]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new UserError(`Flaga --${key} nie dotyczy zdarzenia ${event}.`);
    }
  }
  if (
    event === "forgejo-issue-closed" || event === "forgejo-issue-commented"
  ) {
    for (const key of ["forgejo-url", "forgejo-repo", "forgejo-issue"]) {
      if (!flags[key]) throw new UserError(`Brak --${key}.`);
    }
  }
  if (event === "forgejo-pull-activity") {
    for (const key of ["forgejo-url", "forgejo-repo", "forgejo-pull"]) {
      if (!flags[key]) throw new UserError(`Brak --${key}.`);
    }
  }
  if (event === "zoho-mail-received" && !flags["zoho-profile"]) {
    throw new UserError("Brak --zoho-profile.");
  }
  if (event === "zulip-message-received") {
    if (!flags["zulip-profile"]) throw new UserError("Brak --zulip-profile.");
    if (!flags["zulip-stream"]) throw new UserError("Brak --zulip-stream.");
  }
}
