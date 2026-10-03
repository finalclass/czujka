import { run } from "./cli.ts";

if (import.meta.main) {
  const code = await run(Deno.args);
  Deno.exit(code);
}
