import type { SourcePort } from "../ports.ts";
import type { SecretLoader } from "../secrets.ts";
import { SecretVault } from "../redact.ts";
import type { ByteConn } from "../imap.ts";
import type { Observation, Watch } from "../types.ts";
import {
  observeForgejo,
  observeForgejoComments,
  observeForgejoPull,
} from "./forgejo.ts";
import { observeZoho } from "./zoho.ts";
import { observeZulip } from "./zulip.ts";

export type NetDeps = {
  fetch: typeof fetch;
  secrets: SecretLoader;
  vault: SecretVault;
  now: () => number;
  connectImap?: (host: string) => Promise<ByteConn>;
  timeoutMs?: number;
  pageLimit?: number;
};

export class LiveSources implements SourcePort {
  constructor(private readonly deps: NetDeps) {}

  observe(watch: Watch, _now: number): Promise<Observation> {
    const filters = watch.filters;
    if (filters.event === "forgejo-issue-closed") {
      return observeForgejo(filters, this.deps);
    }
    if (filters.event === "forgejo-issue-commented") {
      const cursor = watch.cursor?.kind === "forgejo-comment"
        ? watch.cursor
        : null;
      return observeForgejoComments(filters, cursor, this.deps);
    }
    if (filters.event === "forgejo-pull-activity") {
      const cursor = watch.cursor?.kind === "forgejo-pull"
        ? watch.cursor
        : null;
      return observeForgejoPull(filters, cursor, this.deps);
    }
    if (filters.event === "zoho-mail-received") {
      const cursor = watch.cursor?.kind === "mail" ? watch.cursor : null;
      return observeZoho(filters, cursor, this.deps);
    }
    const cursor = watch.cursor?.kind === "zulip" ? watch.cursor : null;
    return observeZulip(filters, cursor, this.deps);
  }
}
