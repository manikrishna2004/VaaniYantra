import { describe, it, expect, vi, beforeEach } from 'vitest';

// Recording that a customer accepted the Terms, Privacy Policy and DPA — and
// acknowledged that notifying its own patients is its job (/dpa §4).
//
// The point of these tests is evidentiary, not functional: the columns exist so
// that "did this clinic agree, and to what?" has an answer in a dispute. So what
// matters is that acceptance is stamped ONLY when it genuinely happened, and
// never inferred.

// Bare vi.fn() rather than vi.fn(impl): an inline implementation narrows the
// mock's argument tuple to the implementation's (empty) signature, and then
// reading .mock.calls[0][0] below fails to typecheck. Behaviour is set per-test
// with mockResolvedValue instead.
const orgUpdate = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  membership: { findFirst: vi.fn() },
  organization: { create: vi.fn(), findUnique: vi.fn() },
}));

// ONE mock for '@/lib/db', covering both halves of this file.
//
// There used to be a second vi.mock for the same path further down, adding
// `organization.update` for the /api/legal/accept tests. Both are hoisted, both
// target the same module, and which factory won was scheduling-dependent — so
// the accept tests failed intermittently with `organization.update` undefined,
// and only when other files shifted the run order. Two mocks for one module is
// the bug; merging them is the fix.
vi.mock('@/lib/db', () => ({
  prisma: { ...prismaMock, organization: { ...prismaMock.organization, update: orgUpdate } },
}));

const writeAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit', () => ({ writeAudit }));

import { provisionUser } from '@/lib/auth/provision';
import { LEGAL_VERSION } from '@/lib/legal';

const fb = { uid: 'u-fb', email: 'doctor@clinic.in', name: 'Dr Rao', picture: null };

function orgData() {
  return prismaMock.organization.create.mock.calls[0][0].data;
}

describe('legal acceptance at sign-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 'u1', email: fb.email, firebaseUid: fb.uid });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.membership.findFirst.mockResolvedValue(null);
    prismaMock.organization.create.mockResolvedValue({ id: 'org1', workspaces: [{ id: 'ws1' }] });
    prismaMock.organization.findUnique.mockResolvedValue(null);
    writeAudit.mockResolvedValue(undefined);
  });

  it('stamps the acceptance on the organisation when the box was ticked', async () => {
    await provisionUser(fb, { ip: '203.0.113.9' });

    const data = orgData();
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(data.termsVersion).toBe(LEGAL_VERSION);
    expect(data.termsAcceptedByUserId).toBe('u1');
    expect(data.termsAcceptedIp).toBe('203.0.113.9');
  });

  it('writes an audit event alongside the columns', async () => {
    await provisionUser(fb, { ip: '203.0.113.9' });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0][0] as Record<string, any>;
    expect(entry.action).toBe('org.terms_accepted');
    expect(entry.orgId).toBe('org1');
    expect(entry.actorUserId).toBe('u1');
    expect(entry.ip).toBe('203.0.113.9');
    expect(entry.metadata.version).toBe(LEGAL_VERSION);
    // The record must name what was accepted, so it stays meaningful once the
    // wording moves on.
    expect(entry.metadata.documents).toContain('/dpa');
    expect(entry.metadata.documents).toContain('/patient-notice');
  });

  it('records nothing when no acceptance was passed', async () => {
    await provisionUser(fb);

    const data = orgData();
    expect(data.termsAcceptedAt).toBeUndefined();
    expect(data.termsVersion).toBeUndefined();
    expect(data.termsAcceptedByUserId).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('never re-stamps an existing organisation', async () => {
    // A returning user signing in, or an invited member: they already belong to
    // an org, so no org is created and no acceptance is taken. Acceptance is
    // captured once, from whoever signed the org up.
    prismaMock.membership.findFirst.mockResolvedValue({ id: 'm1', userId: 'u1' });

    await provisionUser(fb, { ip: '203.0.113.9' });

    expect(prismaMock.organization.create).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('tolerates a missing IP rather than refusing the signup', async () => {
    await provisionUser(fb, { ip: null });

    expect(orgData().termsAcceptedIp).toBeNull();
    expect(orgData().termsAcceptedAt).toBeInstanceOf(Date);
  });
});

// ── Re-acceptance, for orgs predating the sign-up box ────────────────────────

const ctxMock = vi.hoisted(() => ({
  ctx: {
    user: { id: 'u1', email: 'owner@clinic.in' },
    org: { id: 'org1', name: 'Clinic', slug: 'clinic', termsVersion: null as string | null },
    workspace: { id: 'ws1', name: 'WS' },
    role: 'OWNER' as string,
  },
}));
vi.mock('@/lib/auth/context', () => ({
  getWorkspaceContext: vi.fn(async () => ctxMock.ctx),
}));

import { POST as acceptRoute } from '@/app/api/legal/accept/route';

function acceptRequest(ip = '198.51.100.4') {
  return new Request('http://test/api/legal/accept', {
    method: 'POST',
    headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` },
  });
}

describe('POST /api/legal/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgUpdate.mockResolvedValue({});
    writeAudit.mockResolvedValue(undefined);
    ctxMock.ctx.role = 'OWNER';
    ctxMock.ctx.org.termsVersion = null;
  });

  it('records the acceptance for an org that has none', async () => {
    const res = await acceptRoute(acceptRequest());
    expect(res.status).toBe(200);

    const data = orgUpdate.mock.calls[0][0].data;
    expect(data.termsVersion).toBe(LEGAL_VERSION);
    expect(data.termsAcceptedByUserId).toBe('u1');
    // Only the client address, not the whole proxy chain.
    expect(data.termsAcceptedIp).toBe('198.51.100.4');
  });

  it('keeps the previous version in the audit trail', async () => {
    ctxMock.ctx.org.termsVersion = '2025-01-01';
    await acceptRoute(acceptRequest());

    const meta = writeAudit.mock.calls[0][0].metadata;
    expect(meta.version).toBe(LEGAL_VERSION);
    // The columns only ever hold the latest, so without this the history of
    // what an org agreed to at each point is unrecoverable.
    expect(meta.previousVersion).toBe('2025-01-01');
    expect(meta.source).toBe('re-accept');
  });

  it('refuses anyone who cannot bind the practice', async () => {
    // Accepting a DPA commits the clinic as Data Fiduciary. An acceptance taken
    // from a front-desk member is worth less than none — it looks like evidence
    // and is not.
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER']) {
      ctxMock.ctx.role = role;
      const res = await acceptRoute(acceptRequest());
      expect(res.status).toBe(403);
    }
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent when the current version is already accepted', async () => {
    ctxMock.ctx.org.termsVersion = LEGAL_VERSION;
    const res = await acceptRoute(acceptRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyAccepted: true });
    // A double-click must not write a second audit row.
    expect(orgUpdate).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
