import assert from "node:assert/strict";
import { SecretVault } from "./redact.ts";

Deno.test("błędy nie zawierają zapamiętanych sekretów", () => {
  const vault = new SecretVault();
  vault.note("abcdef");
  vault.note("sekret-dlugi");
  vault.note("krot");
  const text = vault.redact(
    "token=sekret-dlugi oraz Bearer abcdef.xyz i password: inne-haslo oraz krot",
  );
  assert.equal(text.includes("sekret-dlugi"), false);
  assert.equal(text.includes("abcdef"), false);
  assert.match(text, /\[sekret\]/);
  assert.match(text, /Bearer \[sekret\]/);
  assert.match(text, /password=\[sekret\]/);
  assert.match(text, /krot/);
});
