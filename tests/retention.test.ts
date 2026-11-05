import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Enterprise batch: per-org data retention purge + recording disclosure clause.

const prismaMock = vi.hoisted(() => ({
  organization: { findMany: vi.fn() },
  call: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
  transcriptTurn: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  // Typed arg so `.mock.calls[0][0]` is reachable when asserting the cutoff.
  auditLog: { deleteMany: vi.fn(async (_args: { where: { createdAt: { lt: Date } } }) => ({ count: 0 })) },
  $executeRawUnsafe: vi.fn(async () => 0),
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const writeAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/audit', () => ({ writeAudit }));

// The sweeper also purges spent sign-in codes and dead portal sessions, and
// stamps a liveness marker. Stubbed so this file stays about retention policy
// — without these the real modules reach for tables the mock above lacks, the
// resulting errors get swallowed by the sweeper's own catch handlers, and the
// assertions below would pass without exercising anything.
const purgeExpiredOtps = vi.hoisted(() => vi.fn(async () => 0));
const purgeExpiredLogins = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('@/lib/portal/otp', () => ({ purgeExpiredOtps }));
vi.mock('@/lib/portal/contacts', () => ({ purgeExpiredLogins }));

const setPlatformConfig = vi.hoisted(() => vi.fn(async () => {}));
const getPlatformConfig = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/platform', () => ({ setPlatformConfig, getPlatformConfig }));

import {
  tickRetention,
  retentionCronSecretMatches,
  AUDIT_RETENTION_DAYS,
  LAST_SWEEP_KEY,
} from '@/lib/retention';
import { recordingDisclosureClause, composeSystemInstruction } from '@/lib/voice/prompt';

describe('tickRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no org has retention configured', async () => {
    prismaMock.organization.findMany.mockResolvedValue([]);
    await tickRetention();
    expect(prismaMock.call.findMany).not.toHaveBeenCalled();
  });

  it('purges transcript turns and call content past the window', async () => {
    prismaMock.organization.findMany.mockResolvedValue([{ id: 'o1', dataRetentionDays: 30 }]);
    prismaMock.call.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    prismaMock.transcriptTurn.deleteMany.mockResolvedValue({ count: 12 });

    const now = new Date('2026-07-18T00:00:00Z');
    await tickRetention(now);

    // Cutoff = now - 30d.
    const where = prismaMock.call.findMany.mock.calls[0][0].where;
    expect(where.workspace.orgId).toBe('o1');
    expect(where.createdAt.lt.toISOString()).toBe('2026-06-18T00:00:00.000Z');

    expect(prismaMock.transcriptTurn.deleteMany).toHaveBeenCalledWith({
      where: { callId: { in: ['c1', 'c2'] } },
    });
    expect(prismaMock.call.updateMany).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'o1',
        action: 'data.retention_purge',
        metadata: expect.objectContaining({ calls: 2, transcriptTurns: 12, retentionDays: 30 }),
      }),
    );
  });

  it('skips orgs with nothing to purge and writes no audit entry', async () => {
    prismaMock.organization.findMany.mockResolvedValue([{ id: 'o1', dataRetentionDays: 30 }]);
    prismaMock.call.findMany.mockResolvedValue([]);
    await tickRetention();
    expect(prismaMock.transcriptTurn.deleteMany).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('ignores invalid retention values (< 1 day)', async () => {
    prismaMock.organization.findMany.mockResolvedValue([{ id: 'o1', dataRetentionDays: 0 }]);
    await tickRetention();
    expect(prismaMock.call.findMany).not.toHaveBeenCalled();
  });
});

describe('audit-log retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.organization.findMany.mockResolvedValue([]);
  });

  it('purges audit rows past the platform window', async () => {
    prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 7 });
    const now = new Date('2026-08-24T00:00:00Z');

    const result = await tickRetention(now);

    const where = prismaMock.auditLog.deleteMany.mock.calls[0][0].where;
    const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000);
    expect(where.createdAt.lt.toISOString()).toBe(cutoff.toISOString());
    expect(result.auditRowsPurged).toBe(7);
  });

  it('runs even for orgs that have set no retention window', async () => {
    // The audit window is a platform constant, deliberately not an org setting:
    // a tenant must not be able to shorten the record of what its staff did.
    prismaMock.organization.findMany.mockResolvedValue([]);
    await tickRetention();
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('still sweeps call content when the audit purge fails', async () => {
    prismaMock.auditLog.deleteMany.mockRejectedValue(new Error('deadlock'));
    prismaMock.organization.findMany.mockResolvedValue([{ id: 'o1', dataRetentionDays: 30 }]);
    prismaMock.call.findMany.mockResolvedValue([{ id: 'c1' }]);
    prismaMock.transcriptTurn.deleteMany.mockResolvedValue({ count: 3 });

    const result = await tickRetention();

    expect(prismaMock.transcriptTurn.deleteMany).toHaveBeenCalled();
    expect(result.callsPurged).toBe(1);
    expect(result.auditRowsPurged).toBe(0);
  });
});

describe('sweep liveness marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.organization.findMany.mockResolvedValue([]);
  });

  it('stamps the completion time so a dead sweeper is alertable', async () => {
    const now = new Date('2026-08-24T03:40:00Z');
    const result = await tickRetention(now);

    expect(setPlatformConfig).toHaveBeenCalledWith(LAST_SWEEP_KEY, '2026-08-24T03:40:00.000Z');
    expect(result.ran).toBe(true);
  });

  it('does not advance the marker when a sweep is already in flight', async () => {
    // Re-entry is what makes running the cron and the in-process interval
    // together safe. The second caller must be a no-op, not a second stamp.
    let release!: () => void;
    prismaMock.organization.findMany.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );

    const first = tickRetention();
    const second = await tickRetention();
    expect(second).toEqual({ ran: false, orgsPurged: 0, callsPurged: 0, auditRowsPurged: 0 });

    release();
    await first;
    expect(setPlatformConfig).toHaveBeenCalledTimes(1);
  });
});

describe('retentionCronSecretMatches', () => {
  const original = process.env.RETENTION_CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.RETENTION_CRON_SECRET;
    else process.env.RETENTION_CRON_SECRET = original;
  });

  it('rejects everything when the secret is unset', () => {
    delete process.env.RETENTION_CRON_SECRET;
    expect(retentionCronSecretMatches('anything')).toBe(false);
    expect(retentionCronSecretMatches('')).toBe(false);
    expect(retentionCronSecretMatches(undefined)).toBe(false);
  });

  it('accepts only the exact secret', () => {
    process.env.RETENTION_CRON_SECRET = 'a-real-secret-value';
    expect(retentionCronSecretMatches('a-real-secret-value')).toBe(true);
    expect(retentionCronSecretMatches('a-real-secret-valu')).toBe(false);
    expect(retentionCronSecretMatches('a-real-secret-value ')).toBe(false);
    expect(retentionCronSecretMatches(null)).toBe(false);
  });
});

describe('recording disclosure', () => {
  it('is empty when disabled', () => {
    expect(recordingDisclosureClause(false)).toBe('');
    expect(recordingDisclosureClause(undefined)).toBe('');
  });

  it('is included in the composed system instruction when enabled', () => {
    const base = {
      basePrompt: null,
      corePrompt: 'You are a receptionist.',
      knowledge: '',
      languageMode: 'single',
      language: 'en-IN',
      fallbackMessage: null,
      callGuidance: 'You are on a phone call.',
      greeting: 'Hello!',
    };
    const withOut = composeSystemInstruction(base);
    const withIn = composeSystemInstruction({ ...base, recordingDisclosure: true });
    expect(withOut).not.toContain('RECORDING DISCLOSURE');
    expect(withIn).toContain('RECORDING DISCLOSURE');
    expect(withIn).toContain('recorded for quality and training');
  });
});
