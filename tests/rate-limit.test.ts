import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, clientIp, resetRateLimits } from '@/lib/rate-limit';

const OPTS = { limit: 3, windowMs: 60_000 };

describe('checkRateLimit', () => {
  beforeEach(() => resetRateLimits());

  it('allows requests up to the limit, then blocks', () => {
    const t = 1_000_000;
    expect(checkRateLimit('k', OPTS, t).ok).toBe(true);
    expect(checkRateLimit('k', OPTS, t + 1).ok).toBe(true);
    expect(checkRateLimit('k', OPTS, t + 2).ok).toBe(true);
    const blocked = checkRateLimit('k', OPTS, t + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('resets after the window elapses', () => {
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) checkRateLimit('k', OPTS, t + i);
    expect(checkRateLimit('k', OPTS, t + 4).ok).toBe(false);
    expect(checkRateLimit('k', OPTS, t + OPTS.windowMs + 1).ok).toBe(true);
  });

  it('tracks keys independently', () => {
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) checkRateLimit('a', OPTS, t + i);
    expect(checkRateLimit('a', OPTS, t + 4).ok).toBe(false);
    expect(checkRateLimit('b', OPTS, t + 4).ok).toBe(true);
  });

  it('reports remaining count', () => {
    const t = 1_000_000;
    expect(checkRateLimit('k', OPTS, t).remaining).toBe(2);
    expect(checkRateLimit('k', OPTS, t + 1).remaining).toBe(1);
    expect(checkRateLimit('k', OPTS, t + 2).remaining).toBe(0);
  });

  it('retryAfterSec counts down to the window edge', () => {
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) checkRateLimit('k', OPTS, t);
    const blocked = checkRateLimit('k', OPTS, t + 59_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
  });
});

describe('clientIp', () => {
  // This assertion used to read the other way round, and was wrong: the first
  // hop is whatever the caller put in the header, so keying limits on it let
  // anyone pick their own bucket. Caddy appends the address it actually saw, so
  // with our single proxy hop the LAST entry is the only unforgeable one.
  it('uses the last X-Forwarded-For hop, the one our proxy appended', () => {
    const req = new Request('http://x/', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    expect(clientIp(req)).toBe('10.0.0.1');
  });

  it('falls back to x-real-ip, then unknown', () => {
    expect(clientIp(new Request('http://x/', { headers: { 'x-real-ip': '198.51.100.7' } }))).toBe(
      '198.51.100.7',
    );
    expect(clientIp(new Request('http://x/'))).toBe('unknown');
  });
});
