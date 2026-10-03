import { UserError } from "./errors.ts";

export type Paths = {
  configDir: string;
  configFile: string;
  dataDir: string;
  database: string;
  socket: string;
  lock: string;
  token: string;
};

export type T3Paths = {
  database: string;
  runtime: string;
};

function absoluteOverride(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) {
    throw new UserError(`${label} musi być ścieżką bezwzględną.`);
  }
  return value.replace(/\/$/, "");
}

function xdgDir(
  configured: string | undefined,
  fallbackBase: string,
  name: string,
): string {
  if (configured && configured.startsWith("/")) {
    return `${configured.replace(/\/$/, "")}/${name}`;
  }
  return `${fallbackBase}/${name}`;
}

export function resolvePaths(
  env: Record<string, string | undefined>,
): Paths {
  const home = env.HOME;
  if (!home || !home.startsWith("/")) {
    throw new UserError(
      "Brak katalogu domowego (HOME). Nie można ustalić ścieżek XDG.",
    );
  }
  const configDir = absoluteOverride(
    env.CZUJKA_CONFIG_DIR,
    xdgDir(env.XDG_CONFIG_HOME, `${home}/.config`, "czujka"),
    "CZUJKA_CONFIG_DIR",
  );
  const dataDir = absoluteOverride(
    env.CZUJKA_DATA_DIR,
    xdgDir(env.XDG_DATA_HOME, `${home}/.local/share`, "czujka"),
    "CZUJKA_DATA_DIR",
  );
  return {
    configDir,
    configFile: `${configDir}/config.json`,
    dataDir,
    database: `${dataDir}/state.sqlite`,
    socket: `${dataDir}/daemon.sock`,
    lock: `${dataDir}/daemon.lock`,
    token: `${dataDir}/t3.token`,
  };
}

export function resolveT3Paths(
  env: Record<string, string | undefined>,
): T3Paths {
  const home = env.HOME;
  if (!home || !home.startsWith("/")) {
    throw new UserError(
      "Brak katalogu domowego (HOME). Nie można odnaleźć stanu T3.",
    );
  }
  return {
    database: absoluteOverride(
      env.CZUJKA_T3_DB,
      `${home}/.t3/userdata/state.sqlite`,
      "CZUJKA_T3_DB",
    ),
    runtime: absoluteOverride(
      env.CZUJKA_T3_RUNTIME,
      `${home}/.t3/userdata/server-runtime.json`,
      "CZUJKA_T3_RUNTIME",
    ),
  };
}

export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  await Deno.chmod(path, 0o700);
}
