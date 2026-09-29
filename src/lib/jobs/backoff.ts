/**
 * Exponential backoff with equal jitter: delay is a random point in
 * [exp/2, exp], so retries spread out instead of all landing on the same
 * tick, while still growing roughly exponentially with attempt count.
 */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
}

const DEFAULT_BASE_MS = 5_000;
const DEFAULT_CAP_MS = 10 * 60 * 1000;

export function computeBackoffMs(attemptNumber: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? DEFAULT_BASE_MS;
  const cap = opts.capMs ?? DEFAULT_CAP_MS;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attemptNumber - 1));
  const jitterFloor = exp / 2;
  return Math.round(jitterFloor + Math.random() * jitterFloor);
}
