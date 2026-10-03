/** Healthy sources are polled at this interval and not faster. */
export const HEALTHY_INTERVAL_MS = 15_000;

export const MAX_BACKOFF_MS = 5 * 60_000;

export const MAX_PARALLEL = 4;

export const SOURCE_TIMEOUT_MS = 10_000;

export const IMAP_TIMEOUT_MS = 20_000;

export const PAGE_LIMIT = 100;

export function backoffMs(failures: number, retryAfterMs?: number): number {
  const step = Math.min(Math.max(failures, 1), 6);
  const exponential = Math.min(
    HEALTHY_INTERVAL_MS * 2 ** (step - 1),
    MAX_BACKOFF_MS,
  );
  const hinted = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.max(exponential, hinted);
}
