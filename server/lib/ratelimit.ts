// In-memory sliding-window rate limiter. The server is a single process, so
// memory is authoritative; PIN lockout is additionally persisted on the visit.
import { AppError } from './errors.ts';

interface Bucket { hits: number[] }
const buckets = new Map<string, Bucket>();

export interface Limit { limit: number; windowMs: number }

export const LIMITS = {
  qrResolve: { limit: 30, windowMs: 60_000 },
  join: { limit: 10, windowMs: 60_000 },
  joinPerTable: { limit: 30, windowMs: 60_000 },
  login: { limit: 10, windowMs: 5 * 60_000 },
  loginPerUser: { limit: 8, windowMs: 5 * 60_000 },
  submitOrder: { limit: 20, windowMs: 60_000 },
  quote: { limit: 120, windowMs: 60_000 },
  service: { limit: 20, windowMs: 60_000 },
  portion: { limit: 20, windowMs: 60_000 },
  analytics: { limit: 120, windowMs: 60_000 },
  feedback: { limit: 5, windowMs: 60_000 },
  staffMutation: { limit: 600, windowMs: 60_000 },
} satisfies Record<string, Limit>;

/** Record a hit; throws rate_limited when the key is over its limit. */
export function hit(key: string, { limit, windowMs }: Limit): void {
  const now = Date.now();
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= limit) {
    buckets.set(key, b);
    const retry = Math.ceil((windowMs - (now - b.hits[0])) / 1000);
    throw new AppError('rate_limited', 'Too many attempts. Please wait a moment.', { retry_after_seconds: retry });
  }
  b.hits.push(now);
  buckets.set(key, b);
}

/**
 * Throw rate_limited when `key` is already at its limit, WITHOUT recording a
 * hit. Pair with hit() on failure only (login: successful sign-ins at a shared
 * device must not use up the brute-force budget).
 */
export function assertUnderLimit(key: string, { limit, windowMs }: Limit): void {
  const b = buckets.get(key);
  if (!b) return;
  const now = Date.now();
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= limit) {
    const retry = Math.ceil((windowMs - (now - b.hits[0])) / 1000);
    throw new AppError('rate_limited', 'Too many attempts. Please wait a moment.', { retry_after_seconds: retry });
  }
}

export function resetLimits(): void {
  buckets.clear();
}

// Periodic cleanup so idle keys do not accumulate.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.hits.every((t) => now - t > 15 * 60_000)) buckets.delete(k);
  }
}, 5 * 60_000).unref();
