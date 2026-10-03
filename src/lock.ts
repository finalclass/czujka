import { type FileHandle, open } from "node:fs/promises";
import { AlreadyRunningError } from "./errors.ts";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type FlockLib = {
  symbols: {
    flock(fd: number, operation: number): number;
  };
  close(): void;
};

let libc: FlockLib | null = null;

function flock(fd: number, operation: number): number {
  if (!libc) {
    libc = Deno.dlopen("libc.so.6", {
      flock: { parameters: ["i32", "i32"], result: "i32" },
    }) as FlockLib;
  }
  return libc.symbols.flock(fd, operation);
}

export type DaemonLock = {
  release(): Promise<void>;
};

export async function acquireDaemonLock(path: string): Promise<DaemonLock> {
  const handle: FileHandle = await open(path, "a+");
  await Deno.chmod(path, 0o600);
  const result = flock(handle.fd, LOCK_EX | LOCK_NB);
  if (result !== 0) {
    await handle.close();
    throw new AlreadyRunningError();
  }
  const pid = new TextEncoder().encode(`${Deno.pid}\n`);
  await handle.truncate(0);
  await handle.write(pid, 0, pid.length, 0);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        flock(handle.fd, LOCK_UN);
      } finally {
        await handle.close();
      }
    },
  };
}
