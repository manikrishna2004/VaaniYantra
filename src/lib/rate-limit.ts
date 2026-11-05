// In-process fixed-window rate limiter. Good enough for the single-VM,
// single-process deployment (pm2 fork mode); counters reset on restart and are
// not shared across processes — swap for a Redis/Postgres-backed limiter if the
// app is ever scaled horizontally.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Sweep expired buckets occasionally so the map can't grow unbounded under a
// scan of many distinct keys (e.g. spoofed IPs).
const SWEEP_EVERY = 5_000;
let opsSinceSweep = 0;

export interface RateLimitResult {
  ok: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds until reset — Retry-After value when blocked. */
  retryAfterSec: number;
}

export function checkRateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
  now: number = Date.now(),
): RateLimitResult {
  if (++opsSinceSweep >= SWEEP_EVERY) {
    opsSinceSweep = 0;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  const ok = bucket.count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/**
 * Client IP for rate-limit keying.
 *
 * Take the LAST X-Forwarded-For hop, not the first. Caddy *appends* the peer
 * address it actually saw, so with our single proxy hop the rightmost entry is
 * the one entry a caller cannot forge — everything to its left was supplied by
 * the client. Reading the leftmost, as this used to, let anyone pick their own
 * bucket by sending `X-Forwarded-For: <anything>`, which made every per-IP
 * limit decorative: the walkthrough booker (which writes a calendar event and
 * sends mail per request) and API-key guessing were both keyed on it.
 *
 * This holds for exactly one trusted proxy. Putting a CDN in front of Caddy
 * would add a hop and this would need to count back from the right by however
 * many proxies are actually ours.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** Test hook — clears all counters. */
export function resetRateLimits() {
  buckets.clear();
  opsSinceSweep = 0;
}
