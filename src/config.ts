import { iso } from "./clock.ts";
import { UserError } from "./errors.ts";
import type { Command } from "./parse.ts";
import { type Filters, type Watch } from "./types.ts";

export type ForgejoInstance = {
  profile: string;
  defaultOwner?: string;
};

export type NamedProfile = {
  profile: string;
};

export type AppConfig = {
  forgejo: Record<string, ForgejoInstance>;
  zoho: Record<string, NamedProfile>;
  zulip: Record<string, NamedProfile>;
};

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const PROFILE = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError(`Nieprawidłowy adres „${input}”.`);
  }
  if (url.username || url.password) {
    throw new UserError("Adres nie może zawierać danych logowania.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UserError("Adres musi zaczynać się od https:// albo http://.");
  }
  if (url.search || url.hash) {
    throw new UserError(
      "Adres źródła nie może zawierać zapytania ani fragmentu.",
    );
  }
  const path = url.pathname.replace(/\/$/, "");
  if (path) {
    throw new UserError(
      "Adres Forgejo powinien być originem instancji, bez ścieżki.",
    );
  }
  return `${url.protocol}//${url.host}`;
}

export function forgejoOriginFromApi(api: string): string {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new UserError("FORGEJO_API_URL nie jest adresem.");
  }
  if (url.username || url.password) {
    throw new UserError("FORGEJO_API_URL nie może zawierać danych logowania.");
  }
  const path = url.pathname.replace(/\/$/, "");
  if (path !== "/api/v1") {
    throw new UserError("FORGEJO_API_URL musi wskazywać /api/v1.");
  }
  return `${url.protocol}//${url.host}`;
}

function readName(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROFILE.test(value)) {
    throw new UserError(
      `${label} musi być nazwą profilu (litery, cyfry, ., _, -).`,
    );
  }
  return value;
}

function readInstance(value: unknown, origin: string): ForgejoInstance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(
      `Konfiguracja Forgejo dla ${origin} jest nieprawidłowa.`,
    );
  }
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "profile" && key !== "defaultOwner") {
      throw new UserError(
        `Nieznane pole konfiguracji Forgejo „${key}”. Sekrety nie należą do config.json.`,
      );
    }
  }
  const instance: ForgejoInstance = {
    profile: readName(row.profile, "profile Forgejo"),
  };
  if (row.defaultOwner !== undefined) {
    if (typeof row.defaultOwner !== "string" || !NAME.test(row.defaultOwner)) {
      throw new UserError(`defaultOwner dla ${origin} jest nieprawidłowy.`);
    }
    instance.defaultOwner = row.defaultOwner;
  }
  return instance;
}

function readNamed(value: unknown, label: string): NamedProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`Konfiguracja profilu ${label} jest nieprawidłowa.`);
  }
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "profile") {
      throw new UserError(
        `Nieznane pole konfiguracji „${key}”. Sekrety nie należą do config.json.`,
      );
    }
  }
  return { profile: readName(row.profile, `profil ${label}`) };
}

export function parseConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UserError("Plik konfiguracji czujki musi być obiektem JSON.");
  }
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "forgejo" && key !== "zoho" && key !== "zulip") {
      throw new UserError(`Nieznana sekcja konfiguracji „${key}”.`);
    }
  }
  const forgejo: Record<string, ForgejoInstance> = {};
  if (root.forgejo !== undefined) {
    if (
      !root.forgejo || typeof root.forgejo !== "object" ||
      Array.isArray(root.forgejo)
    ) {
      throw new UserError("Sekcja forgejo jest nieprawidłowa.");
    }
    for (const [origin, value] of Object.entries(root.forgejo)) {
      const normalized = normalizeOrigin(origin);
      if (forgejo[normalized]) {
        throw new UserError(
          `Origin Forgejo ${normalized} jest wpisany drugi raz.`,
        );
      }
      forgejo[normalized] = readInstance(value, normalized);
    }
  }
  const zoho: Record<string, NamedProfile> = {};
  const zulip: Record<string, NamedProfile> = {};
  for (const [section, target] of [["zoho", zoho], ["zulip", zulip]] as const) {
    const block = root[section];
    if (block === undefined) continue;
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new UserError(`Sekcja ${section} jest nieprawidłowa.`);
    }
    for (const [name, value] of Object.entries(block)) {
      if (!PROFILE.test(name)) {
        throw new UserError(`Nazwa profilu „${name}” jest nieprawidłowa.`);
      }
      target[name] = readNamed(value, name);
    }
  }
  return { forgejo, zoho, zulip };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new UserError(
      `Brak konfiguracji ${path}. Skopiuj config.example.json i uzupełnij placeholdery. Sekrety zostają w archea-secrets.`,
    );
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Konfiguracja ${path} nie jest poprawnym JSON.`);
  }
}

function forgejoTarget(
  command: Extract<Command, { kind: "add" }>,
  config: AppConfig,
  numberFlag: "forgejo-issue" | "forgejo-pull" = "forgejo-issue",
): {
  origin: string;
  owner: string;
  repo: string;
  issue: number;
  profile: string;
} {
  const origin = normalizeOrigin(command.flags["forgejo-url"]);
  const instance = config.forgejo[origin];
  if (!instance) {
    throw new UserError(
      `Brak instancji ${origin} w konfiguracji. Profil i domyślny właściciel muszą być przypisane do tego originu.`,
    );
  }
  const repo = splitRepo(command.flags["forgejo-repo"], origin, instance);
  const issue = Number(command.flags[numberFlag]);
  if (
    !/^[1-9][0-9]*$/.test(command.flags[numberFlag] ?? "") ||
    !Number.isSafeInteger(issue)
  ) {
    throw new UserError(
      `--${numberFlag} musi być dodatnią liczbą całkowitą.`,
    );
  }
  return {
    origin,
    owner: repo.owner,
    repo: repo.repo,
    issue,
    profile: instance.profile,
  };
}

function splitRepo(
  repo: string,
  origin: string,
  instance: ForgejoInstance,
): { owner: string; repo: string } {
  if (
    !repo || repo.includes("..") || repo.startsWith("/") || repo.endsWith("/")
  ) {
    throw new UserError("Nieprawidłowa nazwa repozytorium.");
  }
  const parts = repo.split("/");
  if (parts.length === 1) {
    if (!instance.defaultOwner) {
      throw new UserError(
        `Brak właściciela dla ${origin}. Podaj --forgejo-repo=WŁAŚCICIEL/${repo} albo defaultOwner w konfiguracji tej instancji.`,
      );
    }
    if (!NAME.test(parts[0])) {
      throw new UserError("Nieprawidłowa nazwa repozytorium.");
    }
    return { owner: instance.defaultOwner, repo: parts[0] };
  }
  if (parts.length !== 2 || !NAME.test(parts[0]) || !NAME.test(parts[1])) {
    throw new UserError("Repozytorium podaj jako nazwa albo właściciel/nazwa.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function compileWatch(
  command: Extract<Command, { kind: "add" }>,
  config: AppConfig,
  id: string,
  now: number,
): Watch {
  const filters = filtersFrom(command, config);
  const phase = filters.event === "forgejo-issue-closed"
    ? "active"
    : "initializing";
  const stamp = iso(now);
  return {
    id,
    mode: command.mode,
    phase,
    wakeTarget: command.wakeTarget,
    filters,
    cursor: null,
    continuity: null,
    lastCheckAt: null,
    nextCheckAt: stamp,
    lastError: null,
    failures: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function filtersFrom(
  command: Extract<Command, { kind: "add" }>,
  config: AppConfig,
): Filters {
  if (
    command.event === "forgejo-issue-closed" ||
    command.event === "forgejo-issue-commented"
  ) {
    return { event: command.event, ...forgejoTarget(command, config) };
  }
  if (command.event === "forgejo-pull-activity") {
    const target = forgejoTarget(command, config, "forgejo-pull");
    return {
      event: "forgejo-pull-activity",
      origin: target.origin,
      owner: target.owner,
      repo: target.repo,
      pull: target.issue,
      profile: target.profile,
    };
  }
  if (command.event === "zoho-mail-received") {
    const name = command.flags["zoho-profile"];
    const entry = config.zoho[name];
    if (!entry) {
      throw new UserError(`Brak profilu Zoho „${name}” w konfiguracji.`);
    }
    const from = command.flags["mail-from"] ?? null;
    if (
      from && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(from)
    ) {
      throw new UserError("--mail-from musi być samym adresem nadawcy.");
    }
    return {
      event: "zoho-mail-received",
      profile: name,
      secretProfile: entry.profile,
      folder: command.flags["mail-folder"] ?? "INBOX",
      from: from ? from.toLowerCase() : null,
      subjectContains: command.flags["mail-subject-contains"] ?? null,
    };
  }
  const name = command.flags["zulip-profile"];
  const entry = config.zulip[name];
  if (!entry) {
    throw new UserError(`Brak profilu Zulip „${name}” w konfiguracji.`);
  }
  return {
    event: "zulip-message-received",
    profile: name,
    secretProfile: entry.profile,
    stream: command.flags["zulip-stream"],
    topic: command.flags["zulip-topic"] ?? null,
  };
}

export function newWatchId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "w_" +
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newDeliveryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "d_" +
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
