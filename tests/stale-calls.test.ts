import { describe, it, expect, vi, beforeEach } from 'vitest';

// Calls whose end signal was lost (voice-server killed mid-call, or a provider
// status callback that never arrived) used to stay active forever and showed on
// the Live Calls page for days with the elapsed timer still climbing.

const prismaMock = vi.hoisted(() => ({
  call: {
    findMany: vi.fn(async (_args: unknown) => [] as any[]),
    updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { sweepStaleCalls, STALE_AFTER_MS } from '@/lib/calls/stale';

const NOW = new Date('2026-08-27T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A candidate row shaped like the sweeper's `select`. */
function row(over: Partial<any> = {}) {
  return {
    id: 'c1',
    createdAt: ago(2 * 24 * 3600_000), // two days ago
    startedAt: ago(2 * 24 * 3600_000),
    transcript: [] as { createdAt: Date }[],
    ...over,
  };
}

const lastUpdate = () => prismaMock.call.updateMany.mock.calls.at(-1)![0] as any;

describe('sweepStaleCalls', () => {
  beforeEach(() => {
    prismaMock.call.findMany.mockClear();
    prismaMock.call.updateMany.mockClear();
    prismaMock.call.updateMany.mockResolvedValue({ count: 1 });
  });

  it('fails a two-day-old call that never said anything, with zero duration', async () => {
    prismaMock.call.findMany.mockResolvedValueOnce([row()]);
    const res = await sweepStaleCalls(NOW);

    expect(res).toMatchObject({ ran: true, completed: 0, failed: 1 });
    expect(lastUpdate().data).toMatchObject({
      status: 'FAILED',
      durationSec: 0,
      endedReason: 'stale_no_conversation',
    });
  });

  it('bills a reaped call only up to the last thing that was said', async () => {
    const startedAt = ago(2 * 24 * 3600_000);
    prismaMock.call.findMany.mockResolvedValueOnce([
      row({ startedAt, transcript: [{ createdAt: new Date(startedAt.getTime() + 90_000) }] }),
    ]);
    await sweepStaleCalls(NOW);

    const { data } = lastUpdate();
    expect(data.status).toBe('COMPLETED');
    expect(data.endedReason).toBe('stale_no_end_signal');
    // 90s of conversation — NOT the two days the row sat there unreconciled.
    expect(data.durationSec).toBe(90);
    expect(data.endedAt.getTime()).toBe(startedAt.getTime() + 90_000);
  });

  it('leaves a long call alone while it is still producing transcript turns', async () => {
    prismaMock.call.findMany.mockResolvedValueOnce([
      row({
        createdAt: ago(6 * 3600_000), // running six hours
        startedAt: ago(6 * 3600_000),
        transcript: [{ createdAt: ago(5_000) }], // ...and still talking
      }),
    ]);
    const res = await sweepStaleCalls(NOW);

    expect(res).toMatchObject({ completed: 0, failed: 0 });
    expect(prismaMock.call.updateMany).not.toHaveBeenCalled();
  });

  it('only considers calls older than the stale window', async () => {
    await sweepStaleCalls(NOW);
    const where = (prismaMock.call.findMany.mock.calls[0][0] as any).where;
    expect(where.status.in).toEqual(['QUEUED', 'RINGING', 'IN_PROGRESS']);
    expect(where.createdAt.lt.getTime()).toBe(NOW.getTime() - STALE_AFTER_MS);
  });

  it('re-checks the status on write so a real end signal wins the race', async () => {
    prismaMock.call.findMany.mockResolvedValueOnce([row()]);
    // The genuine terminal update landed between the read and the write.
    prismaMock.call.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await sweepStaleCalls(NOW);

    expect(lastUpdate().where.status.in).toEqual(['QUEUED', 'RINGING', 'IN_PROGRESS']);
    expect(res).toMatchObject({ completed: 0, failed: 0 });
  });
});
