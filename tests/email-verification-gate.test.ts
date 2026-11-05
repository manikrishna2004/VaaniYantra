import { describe, it, expect, vi, beforeEach } from 'vitest';

// The gate on /api/auth/session.
//
// This is the test for the bug itself. Sign-up used to create a Firebase account
// and mint a session in the same breath, so an address nobody had proved control
// of got straight into the dashboard. Adding a code step to the sign-up form
// alone would NOT have fixed that: the account still exists with a working
// password, so anyone could skip the form and go to /sign-in instead. This route
// is the only place that can refuse them, which makes these assertions the ones
// that actually close the hole.

const verifyIdToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/firebase/admin', () => ({ adminAuth: { verifyIdToken } }));

const createSession = vi.hoisted(() => vi.fn());
const clearSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ createSession, clearSession }));

const provisionUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/provision', () => ({ provisionUser }));

// The route now asks two questions: "is this address proved?" and "is it let in
// at all?". Only the first is under test here, so the second is stubbed open —
// see invite-only-gate.test.ts for the other one.
const checkPlatformAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/access', () => ({ checkPlatformAccess }));

import { POST } from '@/app/api/auth/session/route';

function post(body: unknown) {
  return new Request('https://app.vaaniyantra.com/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function token(over: Record<string, unknown> = {}) {
  return {
    uid: 'u-fb',
    email: 'doctor@clinic.in',
    name: 'Dr Rao',
    email_verified: true,
    firebase: { sign_in_provider: 'password' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createSession.mockResolvedValue(undefined);
  provisionUser.mockResolvedValue(undefined);
  checkPlatformAccess.mockResolvedValue({ allowed: true, reason: 'open' });
});

describe('unverified email/password accounts', () => {
  it('gets no session, and no tenant is provisioned for it', async () => {
    verifyIdToken.mockResolvedValue(token({ email_verified: false }));

    const res = await POST(post({ idToken: 'tok' }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'email_unverified' });
    // Both matter. No cookie means no access; no provisioning means an
    // abandoned sign-up leaves nothing behind in our database to clean up.
    expect(createSession).not.toHaveBeenCalled();
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it('is refused even when the token omits the claim entirely', async () => {
    // A missing claim must not read as "verified". The check is written as
    // `!== true` rather than `=== false` for exactly this case.
    verifyIdToken.mockResolvedValue(token({ email_verified: undefined }));

    const res = await POST(post({ idToken: 'tok' }));

    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('is refused no matter what the client claims about the terms', async () => {
    verifyIdToken.mockResolvedValue(token({ email_verified: false }));

    const res = await POST(post({ idToken: 'tok', acceptedTerms: true }));

    expect(res.status).toBe(403);
    expect(provisionUser).not.toHaveBeenCalled();
  });
});

describe('accounts that should still get in', () => {
  it('lets a verified email/password account through', async () => {
    verifyIdToken.mockResolvedValue(token());

    const res = await POST(post({ idToken: 'tok' }));

    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith('tok');
    expect(provisionUser).toHaveBeenCalled();
  });

  it('does not make Google users sit through a second challenge', async () => {
    // Google performed its own out-of-band check, and its tokens say so. A code
    // on top of that would add no assurance — only friction on the sign-up path
    // most customers use.
    verifyIdToken.mockResolvedValue(token({ firebase: { sign_in_provider: 'google.com' } }));

    const res = await POST(post({ idToken: 'tok' }));

    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalled();
  });

  it('still rejects a token that does not verify at all', async () => {
    verifyIdToken.mockRejectedValue(new Error('bad token'));

    const res = await POST(post({ idToken: 'tok' }));

    expect(res.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
  });
});
