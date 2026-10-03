import type { Clock } from "./clock.ts";
import { UserError } from "./errors.ts";

export interface SecretLoader {
  load(profile: string, keys: string[]): Promise<Record<string, string>>;
  invalidate?(profile: string): void;
}

const PROFILE = /^[A-Za-z0-9._-]{1,64}$/;

async function secretsBin(): Promise<string> {
  const home = Deno.env.get("HOME");
  if (home && home.startsWith("/")) {
    const local = `${home}/.local/bin/archea-secrets`;
    try {
      await Deno.stat(local);
      return local;
    } catch {
      /* use PATH */
    }
  }
  return "archea-secrets";
}

export class ArcheaSecrets implements SecretLoader {
  async load(profile: string, keys: string[]): Promise<Record<string, string>> {
    if (!PROFILE.test(profile)) {
      throw new UserError("Nieprawidłowa nazwa profilu sekretów.");
    }
    const script = `const keys=${
      JSON.stringify(keys)
    };const out={};for(const k of keys){const v=Deno.env.get(k);if(typeof v==="string"&&v)out[k]=v}console.log(JSON.stringify(out));`;
    let proc: Deno.ChildProcess;
    try {
      proc = new Deno.Command(await secretsBin(), {
        args: [
          "run",
          "--profile",
          profile,
          "--",
          "deno",
          "eval",
          // deno eval ma pełne uprawnienia i odrzuca flagę --allow-env.
          script,
        ],
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
      }).spawn();
    } catch {
      throw new UserError(
        "Brak polecenia archea-secrets. Sekrety usług są potrzebne do odczytu źródła.",
      );
    }
    const out = await proc.output();
    if (!out.success) {
      throw new UserError(`Profil sekretów „${profile}” jest niedostępny.`);
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(out.stdout)) as Record<
        string,
        unknown
      >;
      const result: Record<string, string> = {};
      for (const key of keys) {
        const value = parsed[key];
        if (typeof value === "string") result[key] = value;
      }
      return result;
    } catch {
      throw new UserError(
        `Profil sekretów „${profile}” zwrócił nieczytelny wynik.`,
      );
    }
  }
}

export class CachingSecrets implements SecretLoader {
  private readonly cache = new Map<
    string,
    { at: number; env: Record<string, string> }
  >();

  constructor(
    private readonly inner: SecretLoader,
    private readonly clock: Clock,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async load(profile: string, keys: string[]): Promise<Record<string, string>> {
    const cacheKey = `${profile}\n${keys.join("\n")}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.clock.now() - hit.at < this.ttlMs) return { ...hit.env };
    const env = await this.inner.load(profile, keys);
    this.cache.set(cacheKey, { at: this.clock.now(), env });
    return { ...env };
  }

  invalidate(profile: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${profile}\n`)) this.cache.delete(key);
    }
  }
}
