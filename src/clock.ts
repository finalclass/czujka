export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
