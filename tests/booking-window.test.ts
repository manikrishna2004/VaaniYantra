import { describe, it, expect } from 'vitest';
import { computeOpenSlots } from '@/lib/calendar';

// The booking window.
//
// These exist because of a real, quietly expensive bug: the day loop in
// computeOpenSlots was capped by the TOTAL slot count, so it filled up on day 0
// and never advanced. Every one of the first 16 appointments in production was
// booked for the same day it was created, and the per-agent `lookaheadDays: 14`
// setting did nothing at all. The agent was blamed for "refusing to book next
// week" when it was only ever offered today.
//
// The first test here is the regression guard. If it fails, callers are being
// offered this afternoon when they asked for next Tuesday.

const TZ = 'Asia/Kolkata';

/** 2026-09-01 is a Tuesday. 03:30 UTC == 09:00 IST, i.e. start of business. */
const NOW = new Date('2026-09-01T03:30:00Z');

function opts(over: Partial<Parameters<typeof computeOpenSlots>[1]> = {}) {
  return {
    timezone: TZ,
    durationMin: 20,
    lookaheadDays: 14,
    dailyStartHour: 9,
    dailyEndHour: 18,
    ...over,
  };
}

/** The calendar date each slot falls on, as the clinic reads it. */
function datesOf(slots: { startISO: string }[]): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return slots.map((s) => fmt.format(new Date(s.startISO)));
}

describe('slot distribution across the window', () => {
  it('spreads slots over several days instead of filling up on day 0', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6 }), NOW);
    const days = new Set(datesOf(slots));

    expect(slots).toHaveLength(6);
    // The regression: this used to be exactly 1.
    expect(days.size).toBeGreaterThan(1);
  });

  it('honours maxPerDay so no single day monopolises the list', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6, maxPerDay: 2 }), NOW);
    const counts = new Map<string, number>();
    for (const d of datesOf(slots)) counts.set(d, (counts.get(d) ?? 0) + 1);

    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(2);
    expect(counts.size).toBe(3);
  });

  it('actually reaches the far end of lookaheadDays when the near days are busy', () => {
    // Block the first 10 days entirely; the only free time is day 11+.
    const busy = [{ start: NOW.getTime(), end: NOW.getTime() + 10 * 86400000 }];
    const slots = computeOpenSlots(busy, opts({ maxSlots: 4, lookaheadDays: 14 }), NOW);

    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      // >= not >: a slot starting exactly when the busy block ends is free,
      // since overlap is `start < busy.end`.
      expect(Date.parse(s.startISO)).toBeGreaterThanOrEqual(NOW.getTime() + 10 * 86400000);
    }
  });

  it('returns nothing beyond the configured window rather than ignoring it', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6, lookaheadDays: 2 }), NOW);
    const latest = Math.max(...slots.map((s) => Date.parse(s.startISO)));
    expect(latest).toBeLessThan(NOW.getTime() + 2 * 86400000);
  });
});

describe('a requested date is authoritative', () => {
  it('returns slots on a far date the caller asked for', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6, onDate: '2026-09-10' }), NOW);

    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(datesOf(slots))).toEqual(new Set(['2026-09-10']));
  });

  it('offers more times on that one day, since they all come from it', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6, maxPerDay: 2, onDate: '2026-09-10' }), NOW);
    // maxPerDay must NOT throttle a single-date request down to 2.
    expect(slots).toHaveLength(6);
  });

  it('returns EMPTY for a fully booked date — never another day as a substitute', () => {
    const day = Date.parse('2026-09-10T00:00:00Z');
    const busy = [{ start: day, end: day + 86400000 }];
    const slots = computeOpenSlots(busy, opts({ maxSlots: 6, onDate: '2026-09-10' }), NOW);

    // This is the defect that hid the main bug: the old code filtered after
    // truncating, found nothing, and silently kept today's slots — so the agent
    // read out a day the caller had not asked for.
    expect(slots).toEqual([]);
  });

  it('returns empty for a date beyond the booking window', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6, lookaheadDays: 3, onDate: '2026-10-20' }), NOW);
    expect(slots).toEqual([]);
  });

  it('returns empty for a date in the past', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 6, onDate: '2026-08-01' }), NOW);
    expect(slots).toEqual([]);
  });
});

describe('weekly opening hours', () => {
  /** getDay()-indexed, Sun..Sat. */
  function week(over: Partial<Record<number, { open: string; close: string; closed: boolean }>> = {}) {
    return Array.from({ length: 7 }, (_, i) => over[i] ?? { open: '09:00', close: '18:00', closed: false });
  }

  const dayNames = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  function weekdaysOf(slots: { startISO: string }[]): string[] {
    return slots.map((s) => dayNames.format(new Date(s.startISO)));
  }

  it('never offers a slot on a closed day', () => {
    // Sunday closed. Slot generation had NO weekday concept before this — a
    // clinic shut on Sunday still handed out Sunday appointments, because
    // businessHours.days was only ever read to decide whether to answer calls.
    const weekly = week({ 0: { open: '09:00', close: '18:00', closed: true } });
    const slots = computeOpenSlots([], opts({ maxSlots: 20, maxPerDay: 4, weekly }), NOW);

    expect(slots.length).toBeGreaterThan(0);
    expect(weekdaysOf(slots)).not.toContain('Sun');
  });

  it('returns empty for a requested date that falls on a closed day', () => {
    // 2026-09-06 is a Sunday.
    const weekly = week({ 0: { open: '09:00', close: '18:00', closed: true } });
    const slots = computeOpenSlots([], opts({ maxSlots: 6, onDate: '2026-09-06', weekly }), NOW);
    expect(slots).toEqual([]);
  });

  it('honours per-day hours, and does not lose the last slot to rounding', () => {
    // Saturday 09:00-11:00, 20-minute slots => exactly 6, the last at 10:40.
    //
    // The count is the point. Stepping in fractional hours accumulated to
    // 10.66666666666667, and +1/3 of an hour tipped to 11.000000000000004 —
    // just past the end, so 10:40 was dropped. Every clinic whose day length
    // was not an exact multiple of its slot duration lost its final slot, every
    // single day. Integer minutes fixed it; this pins it.
    const weekly = week({ 6: { open: '09:00', close: '11:00', closed: false } });
    const slots = computeOpenSlots([], opts({ maxSlots: 50, maxPerDay: 50, onDate: '2026-09-05', weekly }), NOW);

    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });
    expect(slots.length).toBe(6);
    for (const s of slots) expect(+hour.format(new Date(s.startISO))).toBeLessThan(11);
  });

  it('supports half-hour opening times', () => {
    // 09:30 could not be expressed at all before: bookingConfig types
    // dailyStart/dailyEnd as integers, even though slot maths handles fractions.
    const weekly = week({ 4: { open: '09:30', close: '12:00', closed: false } });
    // 2026-09-10 is a Thursday.
    const slots = computeOpenSlots([], opts({ maxSlots: 50, maxPerDay: 50, onDate: '2026-09-10', weekly }), NOW);

    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    expect(hm.format(new Date(slots[0].startISO))).toBe('09:30');
  });

  it('falls back to flat daily hours when no weekly schedule is given', () => {
    const withWeekly = computeOpenSlots([], opts({ maxSlots: 6 }), NOW);
    expect(withWeekly.length).toBe(6);
  });
});

describe('invariants that must hold whatever the window does', () => {
  it('never offers a time in the past', () => {
    // Mid-afternoon: the morning of day 0 is already gone.
    const afternoon = new Date('2026-09-01T09:00:00Z'); // 14:30 IST
    const slots = computeOpenSlots([], opts({ maxSlots: 12 }), afternoon);

    for (const s of slots) expect(Date.parse(s.startISO)).toBeGreaterThan(afternoon.getTime());
  });

  it('never offers a time that overlaps a busy interval', () => {
    const start = Date.parse('2026-09-02T03:30:00Z'); // 09:00 IST next day
    const busy = [{ start, end: start + 3 * 3600000 }];
    const slots = computeOpenSlots(busy, opts({ maxSlots: 12 }), NOW);

    for (const s of slots) {
      const a = Date.parse(s.startISO);
      const b = Date.parse(s.endISO);
      expect(a < busy[0].end && b > busy[0].start).toBe(false);
    }
  });

  it('keeps every slot inside business hours in the clinic timezone', () => {
    const slots = computeOpenSlots([], opts({ maxSlots: 12 }), NOW);
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });

    for (const s of slots) {
      const h = +hour.format(new Date(s.startISO));
      expect(h).toBeGreaterThanOrEqual(9);
      // Last 20-min slot starts at 17:40, so the start hour never reaches 18.
      expect(h).toBeLessThan(18);
    }
  });
});
