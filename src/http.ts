export class HttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function isTimeout(err: unknown): boolean {
  return err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError");
}

export async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeout(err)) throw new HttpError("Przekroczono czas oczekiwania.");
    throw new HttpError("Błąd sieci.");
  }
}

export function redirected(status: number): boolean {
  return status >= 300 && status < 400;
}

export function retryAfterMs(
  response: Response,
  now: number,
): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.max(0, when - now);
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now);
  }
  return undefined;
}

export async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}
