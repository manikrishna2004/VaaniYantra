import { describe, it, expect, vi, beforeEach } from 'vitest';

// Moving the session from a ~1-hour Firebase ID token to a 14-day session
// cookie. The behaviour that matters here is the degradation path: minting a
// session cookie needs roles/iam.serviceAccountTokenCreator, and if that role is
// missing this must NOT take every login down with it.

const adminAuth = vi.hoisted(() => ({
  createSessionCookie: vi.fn(),
  verifySessionCookie: vi.fn(),
  verifyIdToken: vi.fn(),
}));
vi.mock('@/lib/firebase/admin', () => ({ adminAuth, adminApp: {} }));

const store = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => store) }));

import { createSession, getSessionUser, SESSION_COOKIE } from '@/lib/auth/session';

const FOURTEEN_DAYS_S = 60 * 60 * 24 * 14;

describe('createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('stores a minted session cookie with a 14-day lifetime', async () => {
    adminAuth.createSessionCookie.mockResolvedValue('SESSION_COOKIE_JWT');

    await createSession('FRESH_ID_TOKEN');

    expect(adminAuth.createSessionCookie).toHaveBeenCalledWith('FRESH_ID_TOKEN', {
      expiresIn: FOURTEEN_DAYS_S * 1000,
    });
    const [name, value, opts] = store.set.mock.calls[0];
    expect(name).toBe(SESSION_COOKIE);
    expect(value).toBe('SESSION_COOKIE_JWT');
    expect(opts.maxAge).toBe(FOURTEEN_DAYS_S);
    expect(opts.httpOnly).toBe(true);
  });

  it('falls back to the raw ID token when minting fails', async () => {
    // The missing-IAM-role case. Without this fallback, granting the role and
    // deploying the code in the wrong order would lock every user out.
    adminAuth.createSessionCookie.mockRejectedValue(new Error('PERMISSION_DENIED'));

    await createSession('FRESH_ID_TOKEN');

    const [, value] = store.set.mock.calls[0];
    expect(value).toBe('FRESH_ID_TOKEN');
    // And says so loudly — the symptom otherwise is silent hourly logouts.
    expect(console.error).toHaveBeenCalled();
  });
});

describe('getSessionUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when there is no cookie', async () => {
    store.get.mockReturnValue(undefined);
    expect(await getSessionUser()).toBeNull();
    expect(adminAuth.verifySessionCookie).not.toHaveBeenCalled();
  });

  it('verifies a session cookie', async () => {
    store.get.mockReturnValue({ value: 'SESSION_JWT' });
    adminAuth.verifySessionCookie.mockResolvedValue({
      uid: 'u1',
      email: 'doctor@clinic.in',
      name: 'Dr Rao',
      picture: null,
    });

    expect(await getSessionUser()).toMatchObject({ uid: 'u1', email: 'doctor@clinic.in' });
    expect(adminAuth.verifyIdToken).not.toHaveBeenCalled();
  });

  it('still accepts an old ID-token cookie', async () => {
    // Sessions issued before this shipped must keep working, or deploying it
    // logs every signed-in user out at once.
    store.get.mockReturnValue({ value: 'LEGACY_ID_TOKEN' });
    adminAuth.verifySessionCookie.mockRejectedValue(new Error('not a session cookie'));
    adminAuth.verifyIdToken.mockResolvedValue({ uid: 'u2', email: 'old@clinic.in' });

    expect(await getSessionUser()).toMatchObject({ uid: 'u2' });
  });

  it('returns null when neither form verifies', async () => {
    store.get.mockReturnValue({ value: 'GARBAGE' });
    adminAuth.verifySessionCookie.mockRejectedValue(new Error('bad'));
    adminAuth.verifyIdToken.mockRejectedValue(new Error('bad'));

    expect(await getSessionUser()).toBeNull();
  });
});
