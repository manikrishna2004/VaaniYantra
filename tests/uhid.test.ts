import { describe, it, expect } from 'vitest';
import { composeUhid, defaultUhidPrefix, normalizeUhidPrefix } from '@/lib/patients/uhid-format';

// The allocator itself is a single atomic UPDATE … RETURNING, so its
// concurrency guarantee is Postgres's, not ours, and it is covered by the
// @@unique([orgId, uhid]) constraint in the schema. What is worth pinning down
// here is the prefix derivation a clinic actually sees on every patient file.

describe('defaultUhidPrefix', () => {
  it('turns a multi-word clinic name into initials', () => {
    expect(defaultUhidPrefix('Smile Dental Care')).toBe('SDC');
    expect(defaultUhidPrefix('Apollo Multi Speciality Hospital')).toBe('AMSH');
  });

  it('truncates a single-word name rather than reducing it to one letter', () => {
    expect(defaultUhidPrefix('Sunrise')).toBe('SUNRIS');
  });

  it('ignores punctuation when forming initials', () => {
    expect(defaultUhidPrefix('St. Mary’s Clinic')).toBe('SMC');
    expect(defaultUhidPrefix('Health-First Diagnostics')).toBe('HFD');
  });

  it('caps the prefix so the number stays short enough to read out', () => {
    expect(defaultUhidPrefix('A B C D E F G H I').length).toBeLessThanOrEqual(6);
  });

  it('falls back rather than producing an empty prefix', () => {
    expect(defaultUhidPrefix('')).toBe('PT');
    expect(defaultUhidPrefix('!!!')).toBe('PT');
  });
});

describe('normalizeUhidPrefix', () => {
  it('uppercases and strips anything that is not alphanumeric', () => {
    expect(normalizeUhidPrefix('sdc')).toBe('SDC');
    expect(normalizeUhidPrefix('s-d c!')).toBe('SDC');
    expect(normalizeUhidPrefix('clinic1')).toBe('CLINIC');
  });

  it('returns null for a blank prefix so the derived default is used', () => {
    expect(normalizeUhidPrefix('')).toBeNull();
    expect(normalizeUhidPrefix('   ')).toBeNull();
    expect(normalizeUhidPrefix(null)).toBeNull();
    expect(normalizeUhidPrefix(undefined)).toBeNull();
  });
});

describe('composeUhid', () => {
  it('zero-pads so numbers sort and line up in a column', () => {
    expect(composeUhid('SDC', 1)).toBe('SDC-000001');
    expect(composeUhid('SDC', 147)).toBe('SDC-000147');
  });

  it('does not truncate a clinic that outgrows six digits', () => {
    expect(composeUhid('SDC', 1_234_567)).toBe('SDC-1234567');
  });
});
