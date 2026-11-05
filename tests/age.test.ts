import { describe, it, expect } from 'vitest';
import {
  parseDateOfBirth,
  formatDateOfBirth,
  formatAge,
  formatAgeShort,
  ageInYears,
  describePatient,
  sexLabel,
} from '@/lib/patients/age';

// Age drives paediatric dosing and what a clinician considers normal, so the
// month/year boundary and the DOB round-trip are both clinical correctness, not
// formatting taste.

const NOW = new Date(Date.UTC(2026, 6, 31)); // 31 Jul 2026

describe('parseDateOfBirth', () => {
  it('parses a calendar date to UTC midnight', () => {
    const d = parseDateOfBirth('1990-05-12', NOW)!;
    expect(d.toISOString()).toBe('1990-05-12T00:00:00.000Z');
  });

  it('round-trips without shifting a day', () => {
    // The trap: a DOB that comes back as the day before. Asserted directly
    // because the failure only shows up later, on a printed document.
    for (const input of ['1990-05-12', '2000-01-01', '2024-12-31', '1985-02-28']) {
      expect(formatDateOfBirth(parseDateOfBirth(input, NOW))).toBe(input);
    }
  });

  it('rejects a date that does not exist', () => {
    // Date would silently roll this into March.
    expect(parseDateOfBirth('2025-02-30', NOW)).toBeNull();
    expect(parseDateOfBirth('2025-13-01', NOW)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseDateOfBirth('12/05/1990', NOW)).toBeNull();
    expect(parseDateOfBirth('1990-5-2', NOW)).toBeNull();
    expect(parseDateOfBirth('', NOW)).toBeNull();
    expect(parseDateOfBirth(null, NOW)).toBeNull();
  });

  it('rejects a future date of birth', () => {
    expect(parseDateOfBirth('2027-01-01', NOW)).toBeNull();
  });

  it('rejects an implausibly old one — a mistyped year, not a person', () => {
    expect(parseDateOfBirth('1850-01-01', NOW)).toBeNull();
    expect(parseDateOfBirth('1920-01-01', NOW)).not.toBeNull();
  });
});

describe('formatAge', () => {
  it('gives days for a newborn', () => {
    expect(formatAge(new Date(Date.UTC(2026, 6, 20)), NOW)).toBe('11 days');
    expect(formatAge(new Date(Date.UTC(2026, 6, 30)), NOW)).toBe('1 day');
  });

  it('gives MONTHS under two years — paediatric dosing depends on it', () => {
    expect(formatAge(new Date(Date.UTC(2025, 0, 31)), NOW)).toBe('18 months');
    expect(formatAge(new Date(Date.UTC(2026, 4, 31)), NOW)).toBe('2 months');
    // 23 months is still months; 24 flips to years.
    expect(formatAge(new Date(Date.UTC(2024, 7, 31)), NOW)).toBe('23 months');
    expect(formatAge(new Date(Date.UTC(2024, 6, 31)), NOW)).toBe('2 years');
  });

  it('gives years for an adult', () => {
    expect(formatAge(new Date(Date.UTC(1992, 6, 31)), NOW)).toBe('34 years');
  });

  it('is empty for a missing date rather than guessing', () => {
    expect(formatAge(null, NOW)).toBe('');
    expect(formatAge(undefined, NOW)).toBe('');
  });
});

describe('ageInYears', () => {
  it('does not round up before the birthday', () => {
    expect(ageInYears(new Date(Date.UTC(1992, 7, 1)), NOW)).toBe(33);
    expect(ageInYears(new Date(Date.UTC(1992, 6, 31)), NOW)).toBe(34);
  });
});

describe('formatAgeShort', () => {
  it('is compact enough for a list row', () => {
    expect(formatAgeShort(new Date(Date.UTC(1992, 6, 31)), NOW)).toBe('34y');
    expect(formatAgeShort(new Date(Date.UTC(2025, 0, 31)), NOW)).toBe('18mo');
  });
});

describe('describePatient', () => {
  it('joins age and sex', () => {
    expect(describePatient(new Date(Date.UTC(1992, 6, 31)), 'female', NOW)).toBe('34 years · Female');
  });

  it('degrades cleanly when either is missing', () => {
    expect(describePatient(new Date(Date.UTC(1992, 6, 31)), null, NOW)).toBe('34 years');
    expect(describePatient(null, 'male', NOW)).toBe('Male');
    expect(describePatient(null, null, NOW)).toBe('');
  });
});

describe('sexLabel', () => {
  it('maps stored values to display labels', () => {
    expect(sexLabel('female')).toBe('Female');
    expect(sexLabel('other')).toBe('Other');
  });

  it('is empty for an unknown value rather than echoing it', () => {
    expect(sexLabel('f')).toBe('');
    expect(sexLabel(null)).toBe('');
  });
});
