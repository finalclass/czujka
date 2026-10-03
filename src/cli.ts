import { systemClock } from "./clock.ts";
import { ask, serve } from "./daemon.ts";
import { AlreadyRunningError, UserError } from "./errors.ts";
import { formatList, formatShow } from "./format.ts";
import { type Command, HELP, parse } from "./parse.ts";
import { ensureDir, resolvePaths, resolveT3Paths } from "./paths.ts";
import { SecretVault } from "./redact.ts";
import { Coordinator } from "./coordinator.ts";
import { LiveSources } from "./sources/live.ts";
import { ArcheaSecrets, CachingSecrets } from "./secrets.ts";
import { Store } from "./store.ts";
import { FileTokenSource, T3Wake } from "./wake/t3.ts";
import type { WatchView } from "./coordinator.ts";

export type IO = {
  log(message: string): void;
  error(message: string): void;
};

const consoleIO: IO = {
  log(message) {
    console.log(message);
  },
  error(message) {
    console.error(message);
  },
};

export async function run(
  argv: string[],
  env: Record<string, string | undefined> = Deno.env.toObject(),
  io: IO = consoleIO,
): Promise<number> {
  try {
    const command = parse(argv);
    if (command.kind === "help") {
      io.log(HELP);
      return 0;
    }
    const paths = resolvePaths(env);
    if (command.kind === "daemon") {
      await runDaemon(paths, env, io);
      return 0;
    }
    print(command, await ask(paths, command), io);
    return 0;
  } catch (err) {
    const vault = new SecretVault();
    const message = err instanceof UserError
      ? err.message
      : vault.redact(err instanceof Error ? err.message : "Błąd czujki.");
    io.error(message);
    return err instanceof AlreadyRunningError ? 2 : 1;
  }
}

async function runDaemon(
  paths: ReturnType<typeof resolvePaths>,
  env: Record<string, string | undefined>,
  io: IO,
): Promise<void> {
  await ensureDir(paths.dataDir);
  const store = Store.open(paths.database);
  const vault = new SecretVault();
  const t3 = resolveT3Paths(env);
  const coordinator = new Coordinator(
    store,
    new LiveSources({
      fetch: globalThis.fetch.bind(globalThis),
      secrets: new CachingSecrets(new ArcheaSecrets(), systemClock),
      vault,
      now: () => systemClock.now(),
    }),
    new T3Wake({
      database: t3.database,
      runtime: t3.runtime,
      tokens: new FileTokenSource(paths.token),
      fetch: globalThis.fetch.bind(globalThis),
      vault,
    }),
    vault,
  );
  let server: { stop(): Promise<void> } | null = null;
  const shutdown = async () => {
    if (!server) return;
    const current = server;
    server = null;
    await current.stop();
    store.close();
  };
  try {
    server = await serve({
      paths,
      coordinator,
      clock: systemClock,
      vault,
      configPath: paths.configFile,
    });
    const onSignal = () => {
      void shutdown().then(() => Deno.exit(0));
    };
    Deno.addSignalListener("SIGINT", onSignal);
    Deno.addSignalListener("SIGTERM", onSignal);
    io.error(`czujka: nasłuch na ${paths.socket}`);
    await new Promise(() => {});
  } finally {
    if (server) await shutdown();
    else store.close();
  }
}

function print(command: Command, result: unknown, io: IO): void {
  if (command.kind === "add") {
    const id = (result as { id?: unknown }).id;
    if (typeof id !== "string") {
      throw new UserError("Demon nie zwrócił identyfikatora.");
    }
    io.log(id);
    return;
  }
  if (command.kind === "list") {
    io.log(formatList(result as WatchView[]));
    return;
  }
  if (command.kind === "show") {
    io.log(formatShow(result as WatchView));
    return;
  }
  if (command.kind === "remove") {
    const row = result as { id?: string; cancelled?: number };
    io.log(`Usunięto ${row.id}. Anulowane dostawy: ${row.cancelled ?? 0}.`);
    return;
  }
  if (command.kind === "status") {
    const row = result as { pid?: number; socket?: string; watches?: number };
    io.log(`Demon działa (pid ${row.pid}).`);
    io.log(`Gniazdo: ${row.socket}`);
    io.log(`Czujki: ${row.watches}`);
  }
}
