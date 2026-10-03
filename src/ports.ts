import type { Delivery, Observation, Watch } from "./types.ts";

export interface SourcePort {
  observe(watch: Watch, now: number): Promise<Observation>;
}

export type ProviderName = "grok" | "codex" | "opencode";

export type ResolvedThread = {
  threadId: string;
  provider: ProviderName;
  runtimeMode: string;
  interactionMode: string;
};

export type ResolveResult =
  | { type: "ready"; thread: ResolvedThread }
  | { type: "deferred"; message: string }
  | { type: "error"; message: string };

export type WakeOutcome =
  | { type: "accepted" }
  | { type: "deferred"; message: string }
  | { type: "error"; message: string }
  | { type: "ambiguous"; message: string };

export interface WakePort {
  resolve(target: string): Promise<ResolveResult>;
  prepare(delivery: Delivery, thread: ResolvedThread): string;
  dispatch(payload: string): Promise<WakeOutcome>;
}
