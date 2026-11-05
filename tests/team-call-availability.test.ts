import { describe, it, expect } from 'vitest';
import { normaliseAvailability, DEFAULT_AVAILABILITY } from '@/lib/team-call';

// The availability row is hand-editable config that drives a PUBLIC booking
// page. Anything unbounded here becomes either a calendar offering slots every
// minute for a year, or one offering nothing at all.

describe('normaliseAvailability', () => {
  it('falls back to the defaults for an empty or unusable row', () => {
    expect(normaliseAvailability(null)).toEqual(DEFAULT_AVAILABILITY);
    expect(normaliseAvailability({} as never)).toEqual(DEFAULT_AVAILABILITY);
  });

  it('clamps numbers into a range a human would actually book in', () => {
    const a = normaliseAvailability({ durationMin: 9999, lookaheadDays: 5000, maxPerDay: 0, minNoticeHours: -5 });
    expect(a.durationMin).toBe(120);
    expect(a.lookaheadDays).toBe(60);
    expect(a.maxPerDay).toBe(1);
    expect(a.minNoticeHours).toBe(0);
  });

  it('ignores a weekly array that is not seven days', () => {
    expect(normaliseAvailability({ weekly: [{ open: '09:00', close: '17:00', closed: false }] }).weekly).toEqual(
      DEFAULT_AVAILABILITY.weekly,
    );
  });

  it('keeps a valid seven-day week, coercing closed to a boolean', () => {
    const weekly = DEFAULT_AVAILABILITY.weekly.map((w) => ({ ...w, open: '08:00' }));
    const a = normaliseAvailability({ weekly: weekly as never });
    expect(a.weekly).toHaveLength(7);
    expect(a.weekly.every((w) => w.open === '08:00')).toBe(true);
    expect(typeof a.weekly[0].closed).toBe('boolean');
  });

  it('defaults to a Mon-Fri week — a weekend sales call is nobody\'s intention', () => {
    expect(DEFAULT_AVAILABILITY.weekly[0].closed).toBe(true); // Sunday
    expect(DEFAULT_AVAILABILITY.weekly[6].closed).toBe(true); // Saturday
    expect(DEFAULT_AVAILABILITY.weekly[3].closed).toBe(false);
  });

  it('keeps a minimum notice, so nobody books a demo eleven minutes from now', () => {
    expect(DEFAULT_AVAILABILITY.minNoticeHours).toBeGreaterThan(0);
  });
});
