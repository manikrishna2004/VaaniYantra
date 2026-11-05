import { describe, it, expect, vi, beforeEach } from 'vitest';

// The money bugs. Each of these was silent: the sweep reported success, the
// webhook returned 200, the invoice looked fine. Nothing failed loudly, the
// numbers were just wrong — which is why they need tests rather than logging.

const db = vi.hoisted(() => ({
  planChange: { findFirst: vi.fn(), create: vi.fn() },
  organization: { findUnique: vi.fn() },
  call: { updateMany: vi.fn() },
  appointment: { updateMany: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));

/** First argument of the nth call to a mock, untyped on purpose. */
const argOf = (fn: unknown, n = 0): any => (fn as { mock: { calls: any[][] } }).mock.calls[n][0];

import { planAt, seedPlanHistory } from '@/lib/plan-history';
import { fillProviderDuration, SILENT_CALL_REASONS } from '@/lib/calls/provider-duration';

beforeEach(() => {
  vi.clearAllMocks();
  db.planChange.findFirst.mockResolvedValue(null);
  db.organization.findUnique.mockResolvedValue({ plan: 'free' });
  db.call.updateMany.mockResolvedValue({ count: 1 });
});

describe('planAt — what the org was on THEN', () => {
  // The downgrade hole: on voice_starter all of July, moved to free on 1 Aug,
  // and the 2 Aug sweep found 'free', which is not billable, so a month of
  // overage was written off in silence.
  it('prices the swept month with the plan held during it, not the plan held now', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'free' }); // what they are NOW
    db.planChange.findFirst.mockResolvedValue({ plan: 'voice_starter' }); // what they were THEN
    expect(await planAt('o1', new Date('2026-07-31T23:59:59Z'))).toBe('voice_starter');
  });

  it('asks only for changes on or before the moment in question', async () => {
    const at = new Date('2026-07-31T23:59:59Z');
    await planAt('o1', at);
    expect(argOf(db.planChange.findFirst).where.changedAt).toEqual({ lte: at });
    expect(argOf(db.planChange.findFirst).orderBy).toEqual({ changedAt: 'desc' });
  });

  it('falls back to the live column when an org has no history yet', async () => {
    db.planChange.findFirst.mockResolvedValue(null);
    db.organization.findUnique.mockResolvedValue({ plan: 'bundle_clinic' });
    expect(await planAt('o1', new Date())).toBe('bundle_clinic');
  });

  it('returns null for an org that does not exist', async () => {
    db.organization.findUnique.mockResolvedValue(null);
    expect(await planAt('gone', new Date())).toBeNull();
  });
});

describe('seedPlanHistory', () => {
  it('backdates the seed, so it is never mistaken for a change during a swept month', async () => {
    await seedPlanHistory('o1', 'voice_starter');
    const data = argOf(db.planChange.create).data;
    expect(data.source).toBe('seed');
    expect(data.changedAt.getTime()).toBeLessThan(new Date('2021-01-01').getTime());
  });

  it('does not seed an org that already has history', async () => {
    db.planChange.findFirst.mockResolvedValue({ id: 'x' });
    await seedPlanHistory('o1', 'voice_starter');
    expect(db.planChange.create).not.toHaveBeenCalled();
  });

  // Recording history must never be the reason a payment or an admin action
  // fails, so the write is allowed to lose.
  it('swallows a write failure rather than breaking its caller', async () => {
    db.planChange.findFirst.mockRejectedValue(new Error('db down'));
    await expect(seedPlanHistory('o1', 'free')).resolves.toBeUndefined();
  });
});

describe('fillProviderDuration — one authority for the billed minute', () => {
  const whereOf = () => argOf(db.call.updateMany).where;

  it('only writes where the voice pipeline left no duration', async () => {
    await fillProviderDuration('c1', 65);
    expect(whereOf().durationSec).toBe(0);
    expect(argOf(db.call.updateMany).data).toEqual({ durationSec: 65 });
  });

  // A call that connected but where nobody spoke is deliberately zero. A late
  // carrier callback must not turn that into a billable 65 seconds.
  it('refuses to make a call with no conversation billable', async () => {
    await fillProviderDuration('c1', 65);
    expect(whereOf().OR).toEqual([
      { endedReason: null },
      { endedReason: { notIn: SILENT_CALL_REASONS } },
    ]);
    expect(SILENT_CALL_REASONS).toContain('no_conversation');
    expect(SILENT_CALL_REASONS).toContain('stale_no_conversation');
  });

  it('ignores a missing or nonsensical duration rather than writing zero', async () => {
    for (const bad of [0, -5, null, undefined, NaN]) {
      await fillProviderDuration('c1', bad as number);
    }
    expect(db.call.updateMany).not.toHaveBeenCalled();
  });

  it('never throws at a webhook, which some carriers do not retry', async () => {
    db.call.updateMany.mockRejectedValue(new Error('db down'));
    await expect(fillProviderDuration('c1', 30)).resolves.toBeUndefined();
  });
});
