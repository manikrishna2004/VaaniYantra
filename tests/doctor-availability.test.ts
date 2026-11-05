import { describe, it, expect, vi, beforeEach } from 'vitest';

// Availability with no Google at all.
//
// A doctor's own hours and their time off are now what shape their day, and both
// live in our database. Before this, leave existed only as an all-day Google
// event — so a doctor who had never connected Google could not be marked
// unavailable at all, and for multi-per-slot agents free/busy was never even
// queried, meaning leave did nothing for exactly the clinics most likely to run
// OPD blocks.

const db = vi.hoisted(() => ({
  schedule: null as null | { days: unknown },
  timeOff: [] as { startAt: Date; endAt: Date }[],
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    doctorSchedule: { findUnique: vi.fn(async () => db.schedule) },
    doctorTimeOff: {
      findMany: vi.fn(async ({ where }: any) =>
        db.timeOff.filter((t) => t.startAt < where.startAt.lt && t.endAt > where.endAt.gt),
      ),
    },
  },
}));

import { doctorWeekly, timeOffBusy } from '@/lib/doctors';
import { computeOpenSlots } from '@/lib/calendar';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-09-01T03:30:00Z'); // Tue 09:00 IST

function week(over: Partial<Record<number, { open: string; close: string; closed: boolean }>> = {}) {
  return Array.from({ length: 7 }, (_, i) => over[i] ?? { open: '09:00', close: '18:00', closed: false });
}

beforeEach(() => {
  db.schedule = null;
  db.timeOff = [];
});

describe('a doctor without hours set', () => {
  it('falls back rather than closing their week', async () => {
    // Null must mean "use the clinic's hours", never "closed all week" — a
    // doctor who has never opened the editor has to stay bookable.
    expect(await doctorWeekly('doc1')).toBeNull();
  });

  it('treats an unenabled schedule the same as none', async () => {
    db.schedule = { days: { enabled: false, timezone: TZ, days: week() } };
    expect(await doctorWeekly('doc1')).toBeNull();
  });
});

describe('a doctor with their own hours', () => {
  it('returns the seven-day window', async () => {
    db.schedule = { days: { enabled: true, timezone: TZ, days: week({ 3: { open: '10:00', close: '13:00', closed: false } }) } };
    const days = await doctorWeekly('doc1');
    expect(days).toHaveLength(7);
    expect(days![3]).toEqual({ open: '10:00', close: '13:00', closed: false });
  });

  it('closes the days they do not work', async () => {
    // Wednesday only. 2026-09-02 is a Wednesday, 2026-09-03 a Thursday.
    const days = week();
    for (let i = 0; i < 7; i++) days[i] = { ...days[i], closed: i !== 3 };
    db.schedule = { days: { enabled: true, timezone: TZ, days } };

    const weekly = await doctorWeekly('doc1');
    const slots = computeOpenSlots([], {
      timezone: TZ, durationMin: 20, lookaheadDays: 7,
      dailyStartHour: 9, dailyEndHour: 18, maxSlots: 20, maxPerDay: 4,
      weekly: weekly!,
    }, NOW);

    const names = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(names.format(new Date(s.startISO))).toBe('Wed');
  });
});

describe('time off', () => {
  it('comes back in the same shape as Google free/busy', async () => {
    // Identical shape on purpose: the slot generator then has one notion of
    // "busy" and does not care where an interval came from.
    const start = Date.parse('2026-09-02T04:00:00Z');
    db.timeOff = [{ startAt: new Date(start), endAt: new Date(start + 3600000) }];

    const busy = await timeOffBusy('doc1', NOW.getTime(), NOW.getTime() + 7 * 86400000);
    expect(busy).toEqual([{ start, end: start + 3600000 }]);
  });

  it('blocks slots with no Google connection anywhere in sight', async () => {
    const dayStart = Date.parse('2026-09-02T03:30:00Z'); // Wed 09:00 IST
    const off = [{ start: dayStart, end: dayStart + 4 * 3600000 }]; // 09:00-13:00

    const slots = computeOpenSlots(off, {
      timezone: TZ, durationMin: 20, lookaheadDays: 3,
      dailyStartHour: 9, dailyEndHour: 18, maxSlots: 40, maxPerDay: 40,
      onDate: '2026-09-02',
    }, NOW);

    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const t = Date.parse(s.startISO);
      expect(t < off[0].end && Date.parse(s.endISO) > off[0].start).toBe(false);
    }
  });

  it('can close a whole day', async () => {
    const dayStart = Date.parse('2026-09-02T00:00:00Z');
    const allDay = [{ start: dayStart, end: dayStart + 86400000 }];
    const slots = computeOpenSlots(allDay, {
      timezone: TZ, durationMin: 20, lookaheadDays: 3,
      dailyStartHour: 9, dailyEndHour: 18, maxSlots: 40, maxPerDay: 40,
      onDate: '2026-09-02',
    }, NOW);
    expect(slots).toEqual([]);
  });
});
