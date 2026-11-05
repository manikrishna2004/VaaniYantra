import { describe, it, expect } from 'vitest';
import {
  allergyStatus,
  formatAllergyBlock,
  summariseAllergies,
  severityLabel,
} from '@/lib/patients/allergies';

// The whole value of this module is that "nobody asked" and "asked, none" stay
// distinguishable. Every test here is guarding that seam.

const REVIEWED = new Date('2026-07-01T10:00:00Z');

function allergy(over: Partial<any> = {}): any {
  return {
    id: 'a1',
    orgId: 'org-A',
    contactId: 'c1',
    substance: 'Penicillin',
    reaction: 'rash',
    severity: 'severe',
    recordedAt: new Date('2026-06-01T00:00:00Z'),
    recordedById: null,
    retiredAt: null,
    ...over,
  };
}

describe('allergyStatus', () => {
  it('is unknown when nobody has asked', () => {
    expect(allergyStatus({ allergiesReviewedAt: null }, [])).toEqual({ state: 'unknown' });
  });

  it('is none-known once someone has asked and found nothing', () => {
    const s = allergyStatus({ allergiesReviewedAt: REVIEWED }, []);
    expect(s.state).toBe('none-known');
  });

  it('never confuses the two — this is the whole point', () => {
    const neverAsked = allergyStatus({ allergiesReviewedAt: null }, []);
    const askedNone = allergyStatus({ allergiesReviewedAt: REVIEWED }, []);
    expect(neverAsked.state).not.toBe(askedNone.state);
  });

  it('is known when there is a live allergy', () => {
    const s = allergyStatus({ allergiesReviewedAt: REVIEWED }, [allergy()]);
    expect(s.state).toBe('known');
    if (s.state === 'known') expect(s.items[0].substance).toBe('Penicillin');
  });

  it('ignores retired allergies but keeps the review date', () => {
    const s = allergyStatus({ allergiesReviewedAt: REVIEWED }, [allergy({ retiredAt: new Date() })]);
    expect(s.state).toBe('none-known');
  });

  it('stays known when rows exist but nobody reviewed in-app', () => {
    // A clinic's own system pushed allergies in. Downgrading these to "unknown"
    // would hide real allergies behind a "not recorded" banner.
    const s = allergyStatus({ allergiesReviewedAt: null }, [allergy()]);
    expect(s.state).toBe('known');
    if (s.state === 'known') expect(s.reviewedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('puts the dangerous ones first', () => {
    const s = allergyStatus({ allergiesReviewedAt: REVIEWED }, [
      allergy({ id: 'mild', substance: 'Dust', severity: 'mild' }),
      allergy({ id: 'sev', substance: 'Penicillin', severity: 'severe' }),
      allergy({ id: 'mod', substance: 'Sulfa', severity: 'moderate' }),
    ]);
    if (s.state !== 'known') throw new Error('expected known');
    expect(s.items.map((i) => i.substance)).toEqual(['Penicillin', 'Sulfa', 'Dust']);
  });
});

describe('formatAllergyBlock', () => {
  it('forbids the model from claiming no allergies when none were taken', () => {
    const block = formatAllergyBlock({ state: 'unknown' });
    expect(block).toContain('NOT RECORDED');
    expect(block).toContain('Do NOT tell them they have no allergies');
  });

  it('states plainly when the clinic did ask and found none', () => {
    const block = formatAllergyBlock({ state: 'none-known', reviewedAt: REVIEWED.toISOString() });
    expect(block).toContain('none known');
    expect(block).not.toContain('NOT RECORDED');
  });

  it('lists them and tells the model not to reassure', () => {
    const s = allergyStatus({ allergiesReviewedAt: REVIEWED }, [allergy()]);
    const block = formatAllergyBlock(s);
    expect(block).toContain('Penicillin');
    expect(block).toContain('Severe');
    expect(block).toContain('rash');
    expect(block).toContain('do not reassure them');
  });
});

describe('summariseAllergies', () => {
  it('reads differently for each state', () => {
    expect(summariseAllergies({ state: 'unknown' })).toBe('Allergies not recorded');
    expect(summariseAllergies({ state: 'none-known', reviewedAt: '' })).toBe('No known allergies');
    expect(
      summariseAllergies(allergyStatus({ allergiesReviewedAt: REVIEWED }, [allergy(), allergy({ id: 'a2', substance: 'Sulfa' })])),
    ).toBe('Penicillin, Sulfa');
  });
});

describe('severityLabel', () => {
  it('maps known values and stays quiet on junk', () => {
    expect(severityLabel('severe')).toBe('Severe');
    expect(severityLabel('catastrophic')).toBe('');
  });
});
