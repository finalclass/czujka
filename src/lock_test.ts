import assert from "node:assert/strict";
import { AlreadyRunningError } from "./errors.ts";
import { acquireDaemonLock } from "./lock.ts";
import { tempHome } from "./testing.ts";

Deno.test("druga blokada w tym samym procesie nie przechodzi", async () => {
  const home = await tempHome();
  const first = await acquireDaemonLock(home.paths.lock);
  try {
    await assert.rejects(
      () => acquireDaemonLock(home.paths.lock),
      AlreadyRunningError,
    );
    const info = await Deno.stat(home.paths.lock);
    assert.equal((info.mode ?? 0) & 0o077, 0);
    assert.equal(await Deno.readTextFile(home.paths.lock), `${Deno.pid}\n`);
  } finally {
    await first.release();
  }
  const second = await acquireDaemonLock(home.paths.lock);
  try {
    assert.equal(await Deno.readTextFile(home.paths.lock), `${Deno.pid}\n`);
  } finally {
    await second.release();
    await home.cleanup();
  }
});
