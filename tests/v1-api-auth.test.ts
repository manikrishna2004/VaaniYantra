import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';

// The public v1 API is the only surface a customer can point their own systems
// at, and it had no test at all: not the key hashing, not revocation, not
// expiry, not the rate limits that stop key guessing. This covers the auth
// seam itself (lib/api-keys.ts + lib/api/v1.ts) rather than any one endpoint.

type Key = {
  id: string;
  orgId: string;
  hashedKey: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  scopes: string[];
};

const keys = vi.hoisted(() => ({ rows: [] as any[] }));

const prismaMock = vi.hoisted(() => ({
  apiKey: {
    findUnique: vi.fn(async ({ where }: any) => keys.rows.find((k) => k.hashedKey === where.hashedKey) ?? null),
    update: vi.fn(async () => ({})),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { authenticateApiKey, generateApiKey, hashApiKey } from '@/lib/api-keys';
import { requireApiAuth } from '@/lib/api/v1';
import { resetRateLimits } from '@/lib/rate-limit';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function addKey(full: string, over: Partial<Key> = {}): Key {
  const row: Key = {
    id: 'k1',
    orgId: 'o1',
    hashedKey: hashApiKey(full),
    revokedAt: null,
    expiresAt: null,
    // Empty by default: that is what every key created before scopes were
    // enforced actually carries, so it is the state worth defaulting to.
    scopes: [],
    ...over,
  };
  keys.rows.push(row);
  return row;
}

const withKey = (token: string, header: 'bearer' | 'x-api-key' = 'bearer', ip = '203.0.113.9') =>
  new Request('http://test/api/v1/calls', {
    headers: {
      'x-forwarded-for': ip,
      ...(header === 'bearer' ? { authorization: `Bearer ${token}` } : { 'x-api-key': token }),
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  keys.rows = [];
  resetRateLimits();
});

describe('API key generation', () => {
  it('mints a prefixed key and stores only its hash', () => {
    const k = generateApiKey();

    expect(k.full.startsWith('ck_live_')).toBe(true);
    expect(k.hashedKey).toBe(sha256(k.full));
    // The plaintext must never be recoverable from what is stored.
    expect(k.hashedKey).not.toContain(k.full);
    expect(k.lastFour).toBe(k.full.slice(-4));
  });

  it('mints a different key every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateApiKey().full));
    expect(seen.size).toBe(50);
  });
});

describe('authenticateApiKey', () => {
  it('accepts a live key via Authorization: Bearer', async () => {
    const { full } = generateApiKey();
    addKey(full);

    await expect(authenticateApiKey(withKey(full))).resolves.toEqual({ orgId: 'o1', keyId: 'k1', scopes: [] });
  });

  it('accepts the same key via x-api-key', async () => {
    const { full } = generateApiKey();
    addKey(full);

    await expect(authenticateApiKey(withKey(full, 'x-api-key'))).resolves.toEqual({ orgId: 'o1', keyId: 'k1', scopes: [] });
  });

  it('rejects a revoked key', async () => {
    const { full } = generateApiKey();
    addKey(full, { revokedAt: new Date('2026-01-01') });

    await expect(authenticateApiKey(withKey(full))).resolves.toBeNull();
  });

  it('rejects an expired key but accepts one expiring in the future', async () => {
    const past = generateApiKey();
    addKey(past.full, { id: 'k-past', expiresAt: new Date(Date.now() - 1000) });
    const future = generateApiKey();
    addKey(future.full, { id: 'k-future', expiresAt: new Date(Date.now() + 60_000) });

    await expect(authenticateApiKey(withKey(past.full))).resolves.toBeNull();
    await expect(authenticateApiKey(withKey(future.full))).resolves.toMatchObject({ keyId: 'k-future' });
  });

  it('rejects an unknown key that is otherwise well formed', async () => {
    const { full } = generateApiKey();
    addKey(full);
    const other = generateApiKey();

    await expect(authenticateApiKey(withKey(other.full))).resolves.toBeNull();
  });

  it('rejects anything without the ck_live_ prefix without hitting the database', async () => {
    for (const token of ['', 'nope', 'sk_live_abc', 'ck_test_abc', 'Bearer', randomBytes(16).toString('hex')]) {
      await expect(authenticateApiKey(withKey(token))).resolves.toBeNull();
    }
    // Key-guessing must not cost a query per attempt.
    expect(prismaMock.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header', async () => {
    await expect(authenticateApiKey(new Request('http://test/api/v1/calls'))).resolves.toBeNull();
  });

  it('does not fail the request when the lastUsedAt write fails', async () => {
    const { full } = generateApiKey();
    addKey(full);
    prismaMock.apiKey.update.mockRejectedValueOnce(new Error('db down'));

    await expect(authenticateApiKey(withKey(full))).resolves.toMatchObject({ orgId: 'o1' });
  });
});

describe('requireApiAuth rate limiting', () => {
  it('401s an invalid key rather than leaking whether it exists', async () => {
    const res = await requireApiAuth(withKey('ck_live_deadbeef'));

    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(401);
    await expect((res as NextResponse).json()).resolves.toEqual({ error: 'Invalid or missing API key' });
  });

  it('caps auth attempts per IP at 240/min so keys cannot be guessed in a flood', async () => {
    const attempt = () => requireApiAuth(withKey('ck_live_wrong', 'bearer', '198.51.100.7'));

    for (let i = 0; i < 240; i++) {
      expect((await attempt() as NextResponse).status).toBe(401);
    }
    const blocked = (await attempt()) as NextResponse;

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('counts the IP limit per IP, not globally', async () => {
    for (let i = 0; i < 241; i++) {
      await requireApiAuth(withKey('ck_live_wrong', 'bearer', '198.51.100.8'));
    }

    // A different caller must be unaffected by someone else's flood.
    const other = (await requireApiAuth(withKey('ck_live_wrong', 'bearer', '198.51.100.9'))) as NextResponse;
    expect(other.status).toBe(401);
  });

  it('caps authenticated requests per key at 120/min', async () => {
    const { full } = generateApiKey();
    addKey(full);

    for (let i = 0; i < 120; i++) {
      await expect(requireApiAuth(withKey(full))).resolves.toMatchObject({ orgId: 'o1', keyId: 'k1' });
    }
    const blocked = (await requireApiAuth(withKey(full))) as NextResponse;

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('returns the auth context for a good key under the limit', async () => {
    const { full } = generateApiKey();
    addKey(full);

    await expect(requireApiAuth(withKey(full))).resolves.toMatchObject({ orgId: 'o1', keyId: 'k1' });
  });
});

describe('scope enforcement', () => {
  const authed = (full: string) => requireApiAuth(withKey(full), 'patients:read');

  it('allows a key whose grant names the scope', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['patients:read'] });

    await expect(authed(full)).resolves.toMatchObject({ orgId: 'o1' });
  });

  it('allows a wildcard key', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['*'] });

    await expect(authed(full)).resolves.toMatchObject({ orgId: 'o1' });
  });

  it('allows a resource wildcard', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['patients:*'] });

    await expect(authed(full)).resolves.toMatchObject({ orgId: 'o1' });
  });

  it('403s — not 401s — a valid key that lacks the scope', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['calls:read'] });

    const res = (await authed(full)) as NextResponse;

    // 401 would send the integrator hunting for a bad key. The failure here is
    // that the key is fine and may not do this.
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'This API key is missing the "patients:read" scope',
      required: ['patients:read'],
    });
  });

  it('does not let a read grant imply the matching write', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['patients:read'] });

    const res = (await requireApiAuth(withKey(full), 'patients:write')) as NextResponse;

    expect(res.status).toBe(403);
  });

  it('does not let one resource grant reach another', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['calls:*'] });

    const res = (await authed(full)) as NextResponse;

    expect(res.status).toBe(403);
  });

  describe('the pre-enforcement default', () => {
    afterEach(() => {
      delete process.env.API_SCOPES_STRICT;
    });

    it('allows a key with no scopes, and says so in the log', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { full } = generateApiKey();
      addKey(full, { scopes: [] });

      await expect(authed(full)).resolves.toMatchObject({ orgId: 'o1' });
      // The warning is the signal that tells us when the strict flip is safe.
      // A silent allow would leave that decision unmeasurable.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no scopes'));
      warn.mockRestore();
    });

    it('denies a key with no scopes once API_SCOPES_STRICT is on', async () => {
      process.env.API_SCOPES_STRICT = 'true';
      const { full } = generateApiKey();
      addKey(full, { scopes: [] });

      const res = (await authed(full)) as NextResponse;

      expect(res.status).toBe(403);
    });

    it('never lets an empty grant through when the route asks for nothing but the key is scoped', async () => {
      // A route that names no scope still authenticates — it just asserts no
      // action. This is the only path that stays permissive by design.
      const { full } = generateApiKey();
      addKey(full, { scopes: ['calls:read'] });

      await expect(requireApiAuth(withKey(full))).resolves.toMatchObject({ orgId: 'o1' });
    });
  });

  it('exposes hasScope on the returned context', async () => {
    const { full } = generateApiKey();
    addKey(full, { scopes: ['calls:read'] });

    const ctx = (await requireApiAuth(withKey(full), 'calls:read')) as Exclude<
      Awaited<ReturnType<typeof requireApiAuth>>,
      NextResponse
    >;

    expect(ctx.hasScope('calls:read')).toBe(true);
    expect(ctx.hasScope('patients:read')).toBe(false);
  });
});
