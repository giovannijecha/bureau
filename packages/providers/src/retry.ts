// withRetry — the single retry-with-backoff primitive both provider adapters use.
// Exponential backoff with full jitter, capped; rethrows immediately on a non-retryable
// error and after the final attempt. The sleep is injectable so tests run instantly.

import { isRetryableError } from "./errors.js";

export interface RetryOptions {
  readonly retries?: number;
  readonly baseMs?: number;
  readonly capMs?: number;
  readonly isRetryable?: (e: unknown) => boolean;
  readonly onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Injectable sleep (tests pass a no-op to avoid real backoff waits). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const capMs = opts.capMs ?? 30_000;
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      // Equal jitter: a delay in [ceil/2, ceil) — keeps spread but never fires with zero
      // backoff (full jitter can hit 0, briefly hammering an overloaded endpoint).
      const ceil = Math.min(capMs, baseMs * 2 ** attempt);
      const delay = Math.floor(ceil / 2 + Math.random() * (ceil / 2));
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable — the loop throws on the final attempt
}
