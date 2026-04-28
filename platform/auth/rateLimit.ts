// Token-bucket rate limiter keyed by string (typically `${ip}:${route}`).
// In-memory; resets on process restart, which is fine for hobby scale.

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiter {
  check(key: string): boolean;
}

export function makeRateLimiter(opts: {
  capacity: number;
  refillPerSec: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    check(key) {
      const now = Date.now();
      const b = buckets.get(key) ?? {
        tokens: opts.capacity,
        lastRefillMs: now,
      };
      const elapsedSec = (now - b.lastRefillMs) / 1000;
      b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
      b.lastRefillMs = now;
      if (b.tokens < 1) {
        buckets.set(key, b);
        return false;
      }
      b.tokens -= 1;
      buckets.set(key, b);
      return true;
    },
  };
}
