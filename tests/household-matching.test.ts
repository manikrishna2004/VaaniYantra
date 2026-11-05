import { describe, it, expect } from 'vitest';
import { matchHouseholdMember } from '@/lib/patients/household';

// Speech-recognised names decide which family member an appointment lands on.
// The rule this file defends: MATCHING MAY SELECT, NEVER CREATE — and when it
// isn't sure, it must say so by returning nothing rather than guessing.

const household = [
  { id: 'mother', name: 'Asha Rao' },
  { id: 'child', name: 'Aarav Rao' },
  { id: 'granny', name: 'Kamala Rao' },
];

describe('matchHouseholdMember', () => {
  it('matches an exact full name', () => {
    expect(matchHouseholdMember(household, 'Aarav Rao')?.id).toBe('child');
  });

  it('matches on the given name alone', () => {
    expect(matchHouseholdMember(household, 'Kamala')?.id).toBe('granny');
  });

  it('tolerates one character of speech-recognition slop', () => {
    // "Aasha" / "Asha" is the commonest transcription variance there is.
    expect(matchHouseholdMember(household, 'Aasha')?.id).toBe('mother');
  });

  it('ignores case, punctuation and diacritics', () => {
    expect(matchHouseholdMember(household, '  aarav! ')?.id).toBe('child');
  });

  it('returns nothing when no one matches — the caller falls back to the primary', () => {
    expect(matchHouseholdMember(household, 'Ramesh')).toBeUndefined();
  });

  it('returns nothing when two people could match', () => {
    // Ambiguity must not be resolved by picking one. A confident wrong answer
    // is worse than an obvious default the front desk can see.
    const twins = [
      { id: 'a', name: 'Rahul Rao' },
      { id: 'b', name: 'Rahul Rao' },
    ];
    expect(matchHouseholdMember(twins, 'Rahul')).toBeUndefined();
  });

  it('does not fuzzy-match short names, where one edit is a different person', () => {
    const short = [
      { id: 'ram', name: 'Ram' },
      { id: 'other', name: 'Priya' },
    ];
    expect(matchHouseholdMember(short, 'Sam')).toBeUndefined();
  });

  it('never matches in a single-person household — there is nothing to choose', () => {
    // The primary is already the answer; running the matcher could only
    // introduce a way to be wrong.
    expect(matchHouseholdMember([{ id: 'only', name: 'Asha Rao' }], 'Asha')).toBeUndefined();
  });

  it('returns nothing for an empty or missing spoken name', () => {
    expect(matchHouseholdMember(household, '')).toBeUndefined();
    expect(matchHouseholdMember(household, null)).toBeUndefined();
    expect(matchHouseholdMember(household, '   ')).toBeUndefined();
  });
});
