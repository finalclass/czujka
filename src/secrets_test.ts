import assert from "node:assert/strict";
import { UserError } from "./errors.ts";
import { ArcheaSecrets, CachingSecrets } from "./secrets.ts";
import { ManualClock, MemorySecrets } from "./testing.ts";

Deno.test("cache sekretów honoruje czas życia i unieważnienie", async () => {
  const inner = new MemorySecrets([{ TOKEN: "pierwszy" }, { TOKEN: "drugi" }]);
  const clock = new ManualClock(0);
  const cache = new CachingSecrets(inner, clock, 1_000);
  assert.equal((await cache.load("forgejo", ["TOKEN"])).TOKEN, "pierwszy");
  assert.equal((await cache.load("forgejo", ["TOKEN"])).TOKEN, "pierwszy");
  assert.equal(inner.loads, 1);
  clock.current = 1_000;
  assert.equal((await cache.load("forgejo", ["TOKEN"])).TOKEN, "drugi");
  assert.equal(inner.loads, 2);
  cache.invalidate("forgejo");
  assert.equal((await cache.load("forgejo", ["TOKEN"])).TOKEN, "drugi");
  assert.equal(inner.loads, 3);
});

Deno.test("zła nazwa profilu nie uruchamia archea-secrets", async () => {
  const secrets = new ArcheaSecrets();
  await assert.rejects(() => secrets.load("../profil", ["TOKEN"]), UserError);
});
