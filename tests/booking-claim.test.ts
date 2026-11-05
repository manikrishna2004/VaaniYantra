import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1-2: claimSlot must take an advisory lock, re-check INSIDE the same
// transaction, and only create when the slot still has room.
//
// Two defects were found here on 2026-08-25 and are pinned below.
//
// 1. The clash test compared `startAt` for EQUALITY, so 09:00-09:30 and
//    09:15-09:45 did not clash. For single-capacity slots the only real
//    collision check was Google's free/busy, so the moment Google became
//    optional a clinic would silently double-book itself.
// 2. The count was ORG-WIDE, so at capacity 1 a two-doctor clinic could only
//    ever hold one 10:00 appointment in total — the second doctor's 10:00 was
//    refused as "full".
//
// The mock below evaluates the real `where` (overlap + doctor + status) rather
// than returning a canned number, so these assertions exercise the predicate
// itself and not just the call plumbing.

type Row = {
  id: string;
  orgId: string;
  doctorId: string | null;
  status: string;
  startAt: Date;
  endAt: Date;
};

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  locks: [] as string[],
  created: [] as any[],
  seq: 0,
}));

function matches(row: Row, where: any): boolean {
  if (where.orgId !== undefined && row.orgId !== where.orgId) return false;
  if (where.doctorId !== undefined && row.doctorId !== where.doctorId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  // Half-open overlap: startAt < end && endAt > start
  if (where.startAt?.lt !== undefined && !(row.startAt < where.startAt.lt)) return false;
  if (where.endAt?.gt !== undefined && !(row.endAt > where.endAt.gt)) return false;
  if (where.NOT?.id !== undefined && row.id === where.NOT.id) return false;
  return true;
}

vi.mock('@/lib/db', () => {
  const tx = {
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...values: any[]) => {
      state.locks.push(String(values[0]));
      return 1;
    }),
    appointment: {
      count: vi.fn(async ({ where }: any) => state.rows.filter((r) => matches(r, where)).length),
      create: vi.fn(async ({ data }: any) => {
        state.created.push(data);
        const row: Row = {
          id: `appt${++state.seq}`,
          orgId: data.orgId,
          doctorId: data.doctorId ?? null,
          status: data.status ?? 'CONFIRMED',
          startAt: data.startAt,
          endAt: data.endAt,
        };
        state.rows.push(row);
        return row;
      }),
    },
  };
  return { prisma: { $transaction: vi.fn(async (fn: (t: any) => Promise<any>) => fn(tx)) } };
});

import { claimSlot } from '@/lib/connectors/booking';

const START = Date.parse('2026-08-01T10:00:00Z');
const HALF_HOUR = 30 * 60000;

function input(over: Partial<Parameters<typeof claimSlot>[0]> = {}) {
  const startMs = over.startMs ?? START;
  const endMs = over.endMs ?? startMs + HALF_HOUR;
  return {
    orgId: 'org1',
    doctorId: null as string | null,
    capacity: 1,
    ...over,
    startMs,
    endMs,
    create: {
      orgId: 'org1',
      workspaceId: 'w1',
      doctorId: (over.doctorId ?? null) as any,
      customerName: 'Asha',
      service: 'appointment',
      startAt: new Date(startMs),
      endAt: new Date(endMs),
      channel: 'sms',
      ...(over.create ?? {}),
    } as any,
  };
}

/** Seed an existing confirmed booking. */
function existing(doctorId: string | null, startMs: number, endMs: number) {
  state.rows.push({
    id: `seed${++state.seq}`,
    orgId: 'org1',
    doctorId,
    status: 'CONFIRMED',
    startAt: new Date(startMs),
    endAt: new Date(endMs),
  });
}

beforeEach(() => {
  state.rows = [];
  state.locks = [];
  state.created = [];
  state.seq = 0;
});

describe('claimSlot basics', () => {
  it('creates the appointment when the slot is free', async () => {
    expect(await claimSlot(input())).toBe('appt1');
    expect(state.created).toHaveLength(1);
  });

  it('refuses when the exact slot is already taken', async () => {
    existing(null, START, START + HALF_HOUR);
    expect(await claimSlot(input())).toBeNull();
    expect(state.created).toHaveLength(0);
  });

  it('respects multi-slot capacity', async () => {
    existing(null, START, START + HALF_HOUR);
    existing(null, START, START + HALF_HOUR);
    existing(null, START, START + HALF_HOUR);
    expect(await claimSlot(input({ capacity: 4 }))).toBe('appt4');

    existing(null, START, START + HALF_HOUR);
    state.created = [];
    expect(await claimSlot(input({ capacity: 4 }))).toBeNull();
    expect(state.created).toHaveLength(0);
  });
});

describe('overlap, not equality', () => {
  it('refuses a booking that overlaps an existing one at a different start', async () => {
    existing(null, START, START + HALF_HOUR); // 10:00-10:30
    // 10:15-10:45 — no shared start instant, but a real clash.
    const id = await claimSlot(input({ startMs: START + 15 * 60000, endMs: START + 45 * 60000 }));
    expect(id).toBeNull();
    expect(state.created).toHaveLength(0);
  });

  it('refuses a booking that fully contains an existing one', async () => {
    existing(null, START + 10 * 60000, START + 20 * 60000);
    const id = await claimSlot(input({ startMs: START, endMs: START + HALF_HOUR }));
    expect(id).toBeNull();
  });

  it('ALLOWS back-to-back bookings, where one ends as the next begins', async () => {
    existing(null, START, START + HALF_HOUR); // 10:00-10:30
    // 10:30-11:00 — touching, not overlapping. Half-open comparison matters:
    // a clinic running consecutive 30-minute slots must not block itself.
    const id = await claimSlot(input({ startMs: START + HALF_HOUR, endMs: START + 2 * HALF_HOUR }));
    expect(id).not.toBeNull();
  });

  it('ignores cancelled appointments when looking for clashes', async () => {
    state.rows.push({
      id: 'cancelled1',
      orgId: 'org1',
      doctorId: null,
      status: 'CANCELLED',
      startAt: new Date(START),
      endAt: new Date(START + HALF_HOUR),
    });
    expect(await claimSlot(input())).not.toBeNull();
  });
});

describe('clashes are scoped to a doctor', () => {
  it('lets two doctors hold the same slot at capacity 1', async () => {
    existing('docA', START, START + HALF_HOUR);
    // Dr B at the same time is not a clash — they are different people. This
    // used to be refused, because the count ran across the whole org.
    const id = await claimSlot(input({ doctorId: 'docB', capacity: 1 }));
    expect(id).not.toBeNull();
  });

  it('still refuses the SAME doctor twice in one slot', async () => {
    existing('docA', START, START + HALF_HOUR);
    expect(await claimSlot(input({ doctorId: 'docA', capacity: 1 }))).toBeNull();
  });

  it('keeps unattributed bookings in their own bucket', async () => {
    // Legacy rows and "any doctor" bookings carry doctorId null; they must not
    // block a named doctor, or every clinic on the old release would seize up.
    existing(null, START, START + HALF_HOUR);
    expect(await claimSlot(input({ doctorId: 'docA', capacity: 1 }))).not.toBeNull();
  });
});

describe('the advisory lock', () => {
  it('takes the lock before counting', async () => {
    await claimSlot(input());
    expect(state.locks).toHaveLength(1);
  });

  it('uses the SAME key for two overlapping times on one doctor', async () => {
    // The original key was `booking:${orgId}:${startMs}` — keyed on the exact
    // start. Once a clash means "overlapping range", two concurrent bookings at
    // 10:00 and 10:15 would hash to different locks, serialize against nothing,
    // and both be written. One key per doctor makes every overlapping pair
    // contend, whatever the times.
    await claimSlot(input({ doctorId: 'docA', startMs: START }));
    await claimSlot(input({ doctorId: 'docA', startMs: START + 15 * 60000, endMs: START + 45 * 60000 }));
    expect(state.locks[0]).toBe(state.locks[1]);
  });

  it('uses DIFFERENT keys for different doctors, so they do not contend', async () => {
    await claimSlot(input({ doctorId: 'docA' }));
    await claimSlot(input({ doctorId: 'docB' }));
    expect(state.locks[0]).not.toBe(state.locks[1]);
  });

  // This used to assert the opposite — that different days take different keys —
  // and that was the bug. The bucket boundary was midnight UTC, which is 05:30
  // in IST: two overlapping bookings either side of it took different locks,
  // each saw no clash inside its own transaction, and both were written. That is
  // precisely the race claimSlot exists to prevent, reintroduced by the key.
  it('keeps one key per doctor, so a booking that straddles midnight UTC still contends', async () => {
    const MIDNIGHT_UTC = Date.UTC(2026, 7, 28, 0, 0, 0);
    await claimSlot(input({ doctorId: 'docA', startMs: MIDNIGHT_UTC - 15 * 60000, endMs: MIDNIGHT_UTC + 15 * 60000 }));
    await claimSlot(input({ doctorId: 'docA', startMs: MIDNIGHT_UTC + 5 * 60000, endMs: MIDNIGHT_UTC + 35 * 60000 }));
    expect(state.locks[0]).toBe(state.locks[1]);
  });

  it('still separates doctors on the same day', async () => {
    await claimSlot(input({ doctorId: 'docA', startMs: START }));
    await claimSlot(input({ doctorId: 'docB', startMs: START + 86400000 }));
    expect(state.locks[0]).not.toBe(state.locks[1]);
  });
});
