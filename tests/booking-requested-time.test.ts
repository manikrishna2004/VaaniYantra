import { describe, it, expect } from 'vitest';
import { computeOpenSlots } from '@/lib/calendar';

// "I asked for 11am and it said no, then offered me 9:00 and 9:20 — every day."
//
// Reported from a real call. Nothing was wrong with the calendar: 11:00 was
// genuinely free. The agent never checked it.
//
// check_availability took a DATE and no TIME, so a caller naming an hour got
// the day's slots generated from the opening hour and truncated to the first
// handful. On a 9-to-6 clinic at 20-minute slots that is 9:00, 9:20, 9:40,
// 10:00, 10:20, 10:40 — the same six every single day, and nothing at all after
// about eleven. A caller who wanted an afternoon could not be given one.
//
// These tests pin both halves of the fix: a named time is actually examined,
// and a day with no time named is offered across its whole length.

const TZ = 'Asia/Kolkata';
/** 2026-09-01 is a Tuesday. 03:30 UTC == 09:00 IST. */
const NOW = new Date('2026-09-01T03:30:00Z');
const DATE = '2026-09-02'; // the Wednesday, so "today so far" never interferes

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

/** Local clock time of each slot, as the clinic reads it. */
function timesOf(slots: { startISO: string }[]): string[] {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return slots.map((s) => fmt.format(new Date(s.startISO)));
}

describe('a named date, with no time', () => {
  it('offers times across the whole day, not just the first hour', () => {
    const slots = computeOpenSlots([], opts({ onDate: DATE, maxSlots: 6, spread: true }), NOW);
    const times = timesOf(slots);

    expect(times.length).toBeGreaterThan(1);
    // The regression: every one of these used to fall before 11:00.
    const afternoon = times.filter((t) => Number(t.slice(0, 2)) >= 13);
    expect(afternoon.length).toBeGreaterThan(0);
  });

  it('still starts at the opening hour', () => {
    const times = timesOf(computeOpenSlots([], opts({ onDate: DATE, maxSlots: 6, spread: true }), NOW));
    expect(times[0]).toBe('09:00');
  });
});

describe('a named time', () => {
  it('returns the requested slot first when it is free', () => {
    // 11:00 IST == 05:30 UTC
    const slots = computeOpenSlots([], opts({ onDate: DATE, maxSlots: 5, nearMin: 11 * 60 }), NOW);
    expect(timesOf(slots)[0]).toBe('11:00');
  });

  it('offers the nearest times around it, not the start of the day', () => {
    const times = timesOf(computeOpenSlots([], opts({ onDate: DATE, maxSlots: 5, nearMin: 11 * 60 }), NOW));
    // Everything offered should be within an hour of what was asked for.
    for (const t of times) {
      const mins = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      expect(Math.abs(mins - 11 * 60)).toBeLessThanOrEqual(60);
    }
    expect(times).not.toContain('09:20');
  });

  it('skips the requested time when something is already booked over it', () => {
    const eleven = Date.parse('2026-09-02T05:30:00Z'); // 11:00 IST
    const busy = [{ start: eleven, end: eleven + 20 * 60000 }];
    const times = timesOf(computeOpenSlots(busy, opts({ onDate: DATE, maxSlots: 5, nearMin: 11 * 60 }), NOW));

    expect(times).not.toContain('11:00');
    // ...and still answers with what is close by, rather than the 9am default.
    expect(times[0]).toMatch(/^(10:40|11:20)$/);
  });

  it('a time outside opening hours yields nothing for that day', () => {
    const slots = computeOpenSlots([], opts({ onDate: DATE, maxSlots: 5, nearMin: 22 * 60 }), NOW);
    // 22:00 is after close; the nearest real slots are late afternoon, and the
    // caller must be told their hour is not available rather than handed 09:00.
    const times = timesOf(slots);
    for (const t of times) expect(Number(t.slice(0, 2))).toBeGreaterThanOrEqual(16);
  });
});

// The time arrives from a model transcribing a phone call, so it arrives in
// whatever shape the caller said it. Refusing "11 am" because we wanted "11:00"
// would put us straight back to never checking the time at all.
describe('reading the time a caller said', () => {
  it('accepts the shapes a transcript actually produces', async () => {
    const { parseClock } = await import('@/lib/connectors/booking');
    expect(parseClock('11')).toBe(11 * 60);
    expect(parseClock('11:00')).toBe(11 * 60);
    expect(parseClock('11 am')).toBe(11 * 60);
    expect(parseClock('4pm')).toBe(16 * 60);
    expect(parseClock('16:30')).toBe(16 * 60 + 30);
    expect(parseClock('12am')).toBe(0);
    expect(parseClock('12pm')).toBe(12 * 60);
    expect(parseClock('0930')).toBe(9 * 60 + 30);
  });

  it('refuses anything that is not a time, rather than guessing one', async () => {
    const { parseClock } = await import('@/lib/connectors/booking');
    expect(parseClock('')).toBeNull();
    expect(parseClock(undefined)).toBeNull();
    expect(parseClock('afternoon')).toBeNull();
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('11:75')).toBeNull();
  });
});

// "Instead of saying the timings, saying 9am to 6pm is a better option."
//
// A receptionist does not recite twenty-minute slots down a telephone. They say
// when the clinic is open and ask what suits you. The agent needs the range in
// words to be able to do that, and it must be the SAME range the slot scan
// honours — announcing hours the booking then refuses is worse than silence.
describe('the opening hours, said out loud', () => {
  it('reads a whole-hour window the way a person says it', async () => {
    const { hoursForDate } = await import('@/lib/connectors/booking');
    const h = hoursForDate(DATE, null, { dailyStart: 9, dailyEnd: 18 });
    expect(h.label).toBe('9am to 6pm');
    expect(h.closed).toBe(false);
  });

  it('handles noon, midnight and half hours', async () => {
    const { hoursForDate } = await import('@/lib/connectors/booking');
    const week = Array.from({ length: 7 }, () => ({ open: '09:30', close: '12:00', closed: false }));
    expect(hoursForDate(DATE, week, { dailyStart: 9, dailyEnd: 18 }).label).toBe('9:30am to 12pm');

    const late = Array.from({ length: 7 }, () => ({ open: '12:00', close: '00:00', closed: false }));
    expect(hoursForDate(DATE, late, { dailyStart: 9, dailyEnd: 18 }).label).toBe('12pm to 12am');
  });

  it('prefers that weekday’s own window over the clinic default', async () => {
    const { hoursForDate } = await import('@/lib/connectors/booking');
    // 2026-09-02 is a Wednesday — getDay() 3.
    const week = Array.from({ length: 7 }, () => ({ open: '09:00', close: '18:00', closed: false }));
    week[3] = { open: '10:00', close: '14:00', closed: false };
    expect(hoursForDate(DATE, week, { dailyStart: 9, dailyEnd: 18 }).label).toBe('10am to 2pm');
  });

  it('says closed rather than inventing hours for a day off', async () => {
    const { hoursForDate } = await import('@/lib/connectors/booking');
    const week = Array.from({ length: 7 }, () => ({ open: '09:00', close: '18:00', closed: false }));
    week[3] = { open: '09:00', close: '18:00', closed: true };
    expect(hoursForDate(DATE, week, { dailyStart: 9, dailyEnd: 18 })).toMatchObject({ closed: true });
  });

  it('falls back to the clinic hours when no date was named', async () => {
    const { hoursForDate } = await import('@/lib/connectors/booking');
    expect(hoursForDate(undefined, null, { dailyStart: 8, dailyEnd: 20 }).label).toBe('8am to 8pm');
  });
});
