import { type Clock, iso } from "./clock.ts";
import type { IO } from "./cli.ts";
import type {
  ResolvedThread,
  ResolveResult,
  SourcePort,
  WakeOutcome,
  WakePort,
} from "./ports.ts";
import { type Paths, resolvePaths } from "./paths.ts";
import type { SecretLoader } from "./secrets.ts";
import type { Delivery, Observation, Watch } from "./types.ts";
import { prepareTurn } from "./wake/t3.ts";

export class ManualClock implements Clock {
  constructor(public current: number) {}

  now(): number {
    return this.current;
  }
}

export function forgejoWatch(overrides: Partial<Watch> = {}): Watch {
  const at = iso(0);
  return {
    id: "w_0123456789ab",
    mode: "on",
    phase: "active",
    wakeTarget: "thread-1",
    filters: {
      event: "forgejo-issue-closed",
      origin: "https://git.example.com",
      owner: "acme",
      repo: "dg",
      issue: 363,
      profile: "forgejo",
    },
    cursor: null,
    continuity: null,
    lastCheckAt: null,
    nextCheckAt: at,
    lastError: null,
    failures: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function zohoWatch(overrides: Partial<Watch> = {}): Watch {
  return forgejoWatch({
    phase: "initializing",
    filters: {
      event: "zoho-mail-received",
      profile: "zoho",
      secretProfile: "zoho",
      folder: "INBOX",
      from: null,
      subjectContains: null,
    },
    ...overrides,
  });
}

export function zulipWatch(overrides: Partial<Watch> = {}): Watch {
  return forgejoWatch({
    phase: "initializing",
    filters: {
      event: "zulip-message-received",
      profile: "zulip",
      secretProfile: "zulip",
      stream: "development",
      topic: null,
    },
    ...overrides,
  });
}

export function forgejoState(
  state: "open" | "closed",
  issue = 363,
): Observation {
  return {
    type: "forgejo",
    state,
    number: issue,
    url: `https://git.example.com/acme/dg/issues/${issue}`,
  };
}

export class FakeSource implements SourcePort {
  readonly calls: Array<{ id: string; now: number }> = [];
  script: Observation[] = [];
  gate: Promise<void> = Promise.resolve();
  active = 0;
  maxActive = 0;

  observe(watch: Watch, now: number): Promise<Observation> {
    this.calls.push({ id: watch.id, now });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const next = this.script.shift() ??
      { type: "error", message: "brak obserwacji" };
    return this.gate.then(() => {
      this.active -= 1;
      return next;
    });
  }
}

export class FakeWake implements WakePort {
  resolveResult: ResolveResult = {
    type: "ready",
    thread: {
      threadId: "thread-1",
      provider: "grok",
      runtimeMode: "approval-required",
      interactionMode: "plan",
    },
  };
  outcome: WakeOutcome | "throw" = { type: "accepted" };
  readonly dispatched: string[] = [];

  resolve(): Promise<ResolveResult> {
    return Promise.resolve(this.resolveResult);
  }

  prepare(delivery: Delivery, thread: ResolvedThread): string {
    return prepareTurn(delivery, thread);
  }

  dispatch(payload: string): Promise<WakeOutcome> {
    this.dispatched.push(payload);
    if (this.outcome === "throw") return Promise.reject(new Error("sieć T3"));
    return Promise.resolve(this.outcome);
  }
}

export class MemorySecrets implements SecretLoader {
  loads = 0;
  invalidations = 0;

  constructor(private readonly envs: Record<string, string>[]) {}

  load(): Promise<Record<string, string>> {
    const env = this.envs[Math.min(this.loads, this.envs.length - 1)] ?? {};
    this.loads += 1;
    return Promise.resolve({ ...env });
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

export async function tempHome(): Promise<{
  root: string;
  env: Record<string, string>;
  paths: Paths;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "czujka-" });
  const env: Record<string, string> = {
    HOME: root,
    CZUJKA_CONFIG_DIR: `${root}/config`,
    CZUJKA_DATA_DIR: `${root}/data`,
    PATH: Deno.env.get("PATH") ?? "",
  };
  await Deno.mkdir(env.CZUJKA_CONFIG_DIR, { recursive: true });
  await Deno.mkdir(env.CZUJKA_DATA_DIR, { recursive: true });
  return {
    root,
    env,
    paths: resolvePaths(env),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

export function bufferIO(): { io: IO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      log(message) {
        lines.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
  };
}

export async function waitFor(
  ready: () => boolean,
  label = "warunek",
): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 2000) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
