import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sign-up is closed. These pin down what "invite-only" actually means, because
// the interesting half of the feature is who it must NOT lock out: the gate runs
// on every sign-in, not just on sign-up, so a mistake here is an outage for
// every paying clinic rather than a bug on a form nobody can reach.

const db = vi.hoisted(() => ({
  membership: { findFirst: vi.fn() },
  invitation: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));

const getPlatformConfig = vi.hoisted(() => vi.fn());
const setPlatformConfig = vi.hoisted(() => vi.fn());
vi.mock('@/lib/platform', () => ({
  getPlatformConfig,
  setPlatformConfig,
  // The real one, so a super-admin email is still resolved from the env.
  isSuperAdmin: (email?: string | null) =>
    (process.env.SUPERADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .includes((email ?? '').toLowerCase()),
}));

import { allowlistMatches, checkPlatformAccess, getAccessAllowlist, inviteOnlyEnabled } from '@/lib/access';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Nothing stored: the env defaults decide.
  getPlatformConfig.mockResolvedValue(null);
  db.membership.findFirst.mockResolvedValue(null);
  db.invitation.findFirst.mockResolvedValue(null);
  vi.stubEnv('SUPERADMIN_EMAILS', 'founder@vaaniyantra.com');
  vi.stubEnv('ACCESS_ALLOWLIST', '');
});

describe('the default', () => {
  it('is closed when INVITE_ONLY is unset', async () => {
    // The first boot after a deploy is exactly when an unprotected sign-up form
    // would be found, so an absent env must not read as "open".
    vi.stubEnv('INVITE_ONLY', '');
    await expect(inviteOnlyEnabled()).resolves.toBe(true);
  });

  it('opens only on an explicit INVITE_ONLY=off', async () => {
    vi.stubEnv('INVITE_ONLY', 'off');
    await expect(inviteOnlyEnabled()).resolves.toBe(false);
  });

  it('lets the stored setting win over the env, so the toggle needs no deploy', async () => {
    vi.stubEnv('INVITE_ONLY', 'on');
    getPlatformConfig.mockResolvedValue('off');
    await expect(inviteOnlyEnabled()).resolves.toBe(false);
  });
});

describe('who is refused', () => {
  it('turns away a stranger, with a code the forms can act on', async () => {
    const decision = await checkPlatformAccess('stranger@example.com');
    expect(decision.allowed).toBe(false);
  });

  it('turns away a token with no email at all', async () => {
    await expect(checkPlatformAccess(null)).resolves.toMatchObject({ allowed: false });
  });

  it('does not accept a User row on its own as permission', async () => {
    // A refused visitor can leave a User row behind from an earlier attempt.
    // Membership is the question — matching on "some user exists" would turn
    // the first refusal into a permanent bypass.
    const decision = await checkPlatformAccess('stranger@example.com');
    expect(decision.allowed).toBe(false);
    expect(db.membership.findFirst).toHaveBeenCalled();
  });
});

describe('who must still get in', () => {
  it('everyone, once the gate is off', async () => {
    vi.stubEnv('INVITE_ONLY', 'off');
    await expect(checkPlatformAccess('anyone@example.com')).resolves.toMatchObject({ allowed: true });
    // Not a single query: the open case must not cost a database round-trip on
    // every sign-in.
    expect(db.membership.findFirst).not.toHaveBeenCalled();
  });

  it('an existing member of any organisation', async () => {
    db.membership.findFirst.mockResolvedValue({ id: 'm1' });
    await expect(checkPlatformAccess('doctor@clinic.in')).resolves.toMatchObject({
      allowed: true,
      reason: 'member',
    });
  });

  it('someone holding a live team invitation', async () => {
    db.invitation.findFirst.mockResolvedValue({ id: 'i1' });
    await expect(checkPlatformAccess('nurse@clinic.in')).resolves.toMatchObject({
      allowed: true,
      reason: 'invitation',
    });
  });

  it('asks only for invitations that are still pending and unexpired', async () => {
    await checkPlatformAccess('nurse@clinic.in');
    const where = db.invitation.findFirst.mock.calls[0][0].where;
    expect(where.status).toBe('PENDING');
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it('the founder, who cannot be locked out of their own console', async () => {
    await expect(checkPlatformAccess('founder@vaaniyantra.com')).resolves.toMatchObject({
      allowed: true,
      reason: 'superadmin',
    });
  });

  it('an address on the allowlist', async () => {
    vi.stubEnv('ACCESS_ALLOWLIST', 'dr.rao@smilecare.in');
    await expect(checkPlatformAccess('DR.RAO@smilecare.in')).resolves.toMatchObject({
      allowed: true,
      reason: 'allowlist',
    });
  });
});

describe('the allowlist itself', () => {
  it('matches a whole domain from an @-prefixed entry', () => {
    expect(allowlistMatches(['@apollo.com'], 'anyone@apollo.com')).toBe(true);
    expect(allowlistMatches(['@apollo.com'], 'anyone@notapollo.com')).toBe(false);
  });

  it('matches an exact address and nothing near it', () => {
    expect(allowlistMatches(['dr@clinic.in'], 'dr@clinic.in')).toBe(true);
    expect(allowlistMatches(['dr@clinic.in'], 'other@clinic.in')).toBe(false);
  });

  it('drops entries that are neither, rather than storing something that can never match', async () => {
    getPlatformConfig.mockResolvedValue(JSON.stringify(['not-an-email', '@', 'ok@clinic.in']));
    await expect(getAccessAllowlist()).resolves.toEqual(['ok@clinic.in']);
  });

  it('survives a corrupt stored value instead of locking everyone out', async () => {
    vi.stubEnv('ACCESS_ALLOWLIST', 'seed@clinic.in');
    getPlatformConfig.mockResolvedValue('{not json');
    await expect(getAccessAllowlist()).resolves.toEqual(['seed@clinic.in']);
  });

  it('merges the env seed with the stored list, de-duplicated', async () => {
    vi.stubEnv('ACCESS_ALLOWLIST', 'seed@clinic.in, dupe@clinic.in');
    getPlatformConfig.mockResolvedValue(JSON.stringify(['DUPE@clinic.in', 'added@clinic.in']));
    await expect(getAccessAllowlist()).resolves.toEqual([
      'seed@clinic.in',
      'dupe@clinic.in',
      'added@clinic.in',
    ]);
  });
});
