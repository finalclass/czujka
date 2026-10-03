import { type Clock } from "./clock.ts";
import { compileWatch, loadConfig, newWatchId } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { UserError } from "./errors.ts";
import { ensureDir, type Paths } from "./paths.ts";
import {
  commandToRpc,
  readLine,
  rpc,
  type RpcRequest,
  writeResponse,
} from "./ipc.ts";
import { acquireDaemonLock } from "./lock.ts";
import type { Command } from "./parse.ts";
import { SecretVault } from "./redact.ts";

export async function serve(options: {
  paths: Paths;
  coordinator: Coordinator;
  clock: Clock;
  vault: SecretVault;
  configPath: string;
  tickMs?: number;
}): Promise<{ stop(): Promise<void> }> {
  await ensureDir(options.paths.dataDir);
  const lock = await acquireDaemonLock(options.paths.lock);
  let listener: Deno.Listener;
  try {
    try {
      await Deno.remove(options.paths.socket);
    } catch {
      /* no stale socket */
    }
    listener = Deno.listen({ transport: "unix", path: options.paths.socket });
    await Deno.chmod(options.paths.socket, 0o600);
  } catch (err) {
    await lock.release();
    throw err;
  }

  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        await options.coordinator.tick(options.clock.now());
      } catch (err) {
        console.error(
          `czujka: ${
            options.vault.redact(
              err instanceof Error ? err.message : "błąd pętli",
            )
          }`,
        );
      }
      await sleep(options.tickMs ?? 1000, abort.signal);
    }
  })();

  const accept = (async () => {
    for await (const conn of listener) {
      if (abort.signal.aborted) {
        conn.close();
        break;
      }
      void handle(conn, options).catch((err) => {
        console.error(
          `czujka: ${
            options.vault.redact(
              err instanceof Error ? err.message : "błąd połączenia",
            )
          }`,
        );
      });
    }
  })();

  let stopping = false;
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      abort.abort();
      try {
        listener.close();
      } catch {
        /* already closed */
      }
      await loop.catch(() => {});
      await accept.catch(() => {});
      try {
        await Deno.remove(options.paths.socket);
      } catch {
        /* already gone */
      }
      await lock.release();
    },
  };
}

async function handle(conn: Deno.Conn, options: {
  paths: Paths;
  coordinator: Coordinator;
  clock: Clock;
  vault: SecretVault;
  configPath: string;
}): Promise<void> {
  try {
    const line = await readLine(conn);
    const request = JSON.parse(line) as RpcRequest;
    const result = await dispatch(request, options);
    await writeResponse(conn, { ok: true, result });
  } catch (err) {
    const message = err instanceof UserError
      ? err.message
      : options.vault.redact(
        err instanceof Error ? err.message : "Nieoczekiwany błąd demona.",
      );
    try {
      await writeResponse(conn, { ok: false, error: message });
    } catch {
      /* client gone */
    }
  } finally {
    conn.close();
  }
}

async function dispatch(request: RpcRequest, options: {
  paths: Paths;
  coordinator: Coordinator;
  clock: Clock;
  vault: SecretVault;
  configPath: string;
}): Promise<unknown> {
  switch (request.op) {
    case "add": {
      const config = await loadConfig(options.configPath);
      const watch = compileWatch(
        request.command,
        config,
        newWatchId(),
        options.clock.now(),
      );
      const saved = await options.coordinator.add(watch);
      void options.coordinator.tick(options.clock.now()).catch((err) => {
        console.error(
          `czujka: ${
            options.vault.redact(
              err instanceof Error ? err.message : "błąd pętli",
            )
          }`,
        );
      });
      return { id: saved.id };
    }
    case "list":
      return await options.coordinator.list();
    case "show":
      return await options.coordinator.show(request.id);
    case "remove": {
      const cancelled = await options.coordinator.remove(
        request.id,
        options.clock.now(),
      );
      return { id: request.id, cancelled };
    }
    case "status": {
      const watches = await options.coordinator.list();
      return {
        pid: Deno.pid,
        socket: options.paths.socket,
        watches: watches.length,
      };
    }
    default:
      throw new UserError("Nieznane polecenie demona.");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function ask(
  paths: Paths,
  command: Exclude<Command, { kind: "help" | "daemon" }>,
): Promise<unknown> {
  return await rpc(paths.socket, commandToRpc(command));
}
