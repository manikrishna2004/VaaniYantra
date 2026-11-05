import { describe, it, expect, vi, beforeEach } from 'vitest';

// A patient session reaches real medical records, so every way of getting in
// with the wrong one has to stay closed. These are the cases that would show
// one patient's history to somebody else.
//
// The credential used to be a bearer token in the link itself. It is now a
// per-login token whose SHA-256 is what's stored, issued only after the patient
// verified their phone number — see tests/portal-otp.test.ts for that half.

const state = vi.hoisted(() => ({
  portal: null as any,
  login: null as any,
  updated: [] as any[],
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    portal: { findUnique: vi.fn(async () => state.portal) },
    portalLogin: {
      findUnique: vi.fn(async () => state.login),
      update: vi.fn(async (a: any) => {
        state.updated.push(a);
        return {};
      }),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    contact: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => []),
  },
}));

import { resolvePortalSession, issuePortalToken, portalLink } from '@/lib/portal/contacts';

const PORTAL = { id: 'p1', slug: 'smile-dental', orgId: 'org-A', enabled: true };
const CONTACT = { id: 'c1', orgId: 'org-A', portalRevokedAt: null };
const future = (ms: number) => new Date(Date.now() + ms);

function login(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    portalId: 'p1',
    contactId: 'c1',
    contact: { ...CONTACT },
    expiresAt: future(30 * 24 * 3600 * 1000),
    revokedAt: null,
    ...over,
  };
}

describe('resolvePortalSession', () => {
  beforeEach(() => {
    state.portal = { ...PORTAL };
    state.login = login();
    state.updated = [];
  });

  it('accepts a live session for the matching portal', async () => {
    const session = await resolvePortalSession('smile-dental', 'tok-good');
    expect(session?.contact.id).toBe('c1');
  });

  it('rejects a missing token', async () => {
    expect(await resolvePortalSession('smile-dental', '')).toBeNull();
    expect(await resolvePortalSession('smile-dental', undefined)).toBeNull();
  });

  it('rejects an unknown token', async () => {
    state.login = null;
    expect(await resolvePortalSession('smile-dental', 'tok-nope')).toBeNull();
  });

  it('rejects an expired session', async () => {
    state.login = login({ expiresAt: new Date(Date.now() - 1000) });
    expect(await resolvePortalSession('smile-dental', 'tok-old')).toBeNull();
  });

  it('rejects a session revoked on sign-out', async () => {
    state.login = login({ revokedAt: new Date() });
    expect(await resolvePortalSession('smile-dental', 'tok-good')).toBeNull();
  });

  it('rejects a patient whose portal access was blocked', async () => {
    // Staff blocked them after a phone was lost — an already-open session must
    // die too, not just the next sign-in.
    state.login = login({ contact: { ...CONTACT, portalRevokedAt: new Date() } });
    expect(await resolvePortalSession('smile-dental', 'tok-good')).toBeNull();
  });

  it('rejects a session issued for a different portal', async () => {
    // The cookie is shared across portals, so this check is what stops one
    // clinic's cookie opening another clinic's chatbot.
    state.login = login({ portalId: 'p-other' });
    expect(await resolvePortalSession('smile-dental', 'tok-good')).toBeNull();
  });

  it('rejects a patient belonging to a different tenant', async () => {
    // Belt and braces behind the portalId check: a slug could be reused after a
    // clinic deletes its chatbot.
    state.login = login({ contact: { ...CONTACT, orgId: 'org-B' } });
    expect(await resolvePortalSession('smile-dental', 'tok-good')).toBeNull();
  });

  it('rejects a disabled portal', async () => {
    state.portal = { ...PORTAL, enabled: false };
    expect(await resolvePortalSession('smile-dental', 'tok-good')).toBeNull();
  });

  it('rejects an unknown portal slug', async () => {
    state.portal = null;
    expect(await resolvePortalSession('nope', 'tok-good')).toBeNull();
  });

  it('does not write on every request — only when expiry is near', async () => {
    // A write per message would make every chat turn a database update.
    await resolvePortalSession('smile-dental', 'tok-good');
    expect(state.updated).toHaveLength(0);

    state.login = login({ expiresAt: future(24 * 3600 * 1000) }); // 1 day left
    await resolvePortalSession('smile-dental', 'tok-good');
    expect(state.updated).toHaveLength(1);
  });
});

describe('session tokens', () => {
  it('are long, URL-safe and unguessable', () => {
    const token = issuePortalToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes in base64url.
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('do not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => issuePortalToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('portalLink', () => {
  it('carries no secret — the patient signs in with a code instead', () => {
    process.env.PUBLIC_BASE_URL = 'https://vaaniyantra.com';
    expect(portalLink('smile-dental')).toBe('https://vaaniyantra.com/c/smile-dental');
    // Safe to forward: this is the whole point of the OTP cutover.
    expect(portalLink('smile-dental')).not.toContain('?k=');
  });

  it('does not double the slash on a trailing-slash base url', () => {
    process.env.PUBLIC_BASE_URL = 'https://vaaniyantra.com/';
    expect(portalLink('smile-dental')).toBe('https://vaaniyantra.com/c/smile-dental');
  });
});
