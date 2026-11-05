import { describe, it, expect } from 'vitest';
import {
  renderPrescription,
  formatItem,
  dosesPerDay,
  parseRxItems,
  MAX_RX_ITEMS,
} from '@/lib/patients/prescription';

describe('renderPrescription — items win, never both', () => {
  it('renders items and IGNORES the free text when both are present', () => {
    const out = renderPrescription({
      items: [{ drug: 'Amoxicillin', strength: '500 mg', frequency: 'bd', durationDays: 5 }],
      prescription: 'amox 500 TDS x 7 days',
    });
    expect(out.kind).toBe('items');
    // The whole point: the stale/ambiguous prose must not reach the patient.
    expect(out.kind === 'items' && out.text).not.toContain('TDS');
    expect(out.kind === 'items' && out.text).not.toContain('7 days');
    expect(out.kind === 'items' && out.text).toContain('twice a day');
  });

  it('falls back to the free text when there are no items', () => {
    const out = renderPrescription({ items: [], prescription: 'Paracetamol 650 SOS' });
    expect(out).toEqual({ kind: 'text', text: 'Paracetamol 650 SOS' });
  });

  it('treats an items array of blank-drug rows as no items', () => {
    const out = renderPrescription({
      items: [{ drug: '   ' }],
      prescription: 'legacy script',
    });
    expect(out.kind).toBe('text');
  });

  it('reports none when there is nothing at all', () => {
    expect(renderPrescription({}).kind).toBe('none');
    expect(renderPrescription({ prescription: '   ' }).kind).toBe('none');
  });
});

describe('formatItem', () => {
  it('expands the abbreviation AND keeps it', () => {
    const line = formatItem({
      drug: 'Amoxicillin',
      strength: '500 mg',
      dose: '1 tablet',
      frequency: 'bd',
      route: 'oral',
      durationDays: 5,
      instructions: 'after food',
    });
    expect(line).toBe('Amoxicillin 500 mg — 1 tablet, twice a day (BD), by mouth, for 5 days, after food');
  });

  it('renders a drug name alone without a dangling separator', () => {
    expect(formatItem({ drug: 'Amoxicillin' })).toBe('Amoxicillin');
  });

  it('does not echo an abbreviation that is already words', () => {
    const line = formatItem({ drug: 'Methotrexate', frequency: 'weekly' });
    expect(line).toBe('Methotrexate — once a week');
    expect(line).not.toContain('(WEEKLY)');
  });

  it('singularises a one-day course', () => {
    expect(formatItem({ drug: 'Ondansetron', durationDays: 1 })).toContain('for 1 day');
    expect(formatItem({ drug: 'Ondansetron', durationDays: 2 })).toContain('for 2 days');
  });

  it('omits the route when it carries no patient wording', () => {
    expect(formatItem({ drug: 'X', route: 'other' })).toBe('X');
  });
});

describe('dosesPerDay', () => {
  it('answers "how many today" by lookup', () => {
    expect(dosesPerDay({ drug: 'a', frequency: 'od' })).toBe(1);
    expect(dosesPerDay({ drug: 'a', frequency: 'bd' })).toBe(2);
    expect(dosesPerDay({ drug: 'a', frequency: 'tds' })).toBe(3);
    expect(dosesPerDay({ drug: 'a', frequency: 'qid' })).toBe(4);
    expect(dosesPerDay({ drug: 'a', frequency: 'hs' })).toBe(1);
  });

  it('returns null where the answer is genuinely not a number', () => {
    // SOS is as-needed and STAT is once ever — inventing a number here is the
    // exact overdose risk this function exists to remove.
    expect(dosesPerDay({ drug: 'a', frequency: 'sos' })).toBeNull();
    expect(dosesPerDay({ drug: 'a', frequency: 'stat' })).toBeNull();
    expect(dosesPerDay({ drug: 'a', frequency: 'weekly' })).toBeNull();
    expect(dosesPerDay({ drug: 'a' })).toBeNull();
  });
});

describe('parseRxItems', () => {
  it('accepts a JSON string, the wire format the form sends', () => {
    const out = parseRxItems(JSON.stringify([{ drug: 'Metformin', frequency: 'bd' }]));
    expect(out).toEqual({ items: [expect.objectContaining({ drug: 'Metformin', frequency: 'bd' })] });
  });

  it('treats an empty string and an empty array alike: clear the medicines', () => {
    expect(parseRxItems('')).toEqual({ items: [] });
    expect(parseRxItems([])).toEqual({ items: [] });
  });

  it('drops wholly blank rows rather than erroring on them', () => {
    // An untouched "add medicine" row looks exactly like this.
    const out = parseRxItems([{ drug: '', strength: '', dose: '' }, { drug: 'Ibuprofen' }]);
    expect(out).toEqual({ items: [expect.objectContaining({ drug: 'Ibuprofen' })] });
  });

  it('rejects a row with details but no drug name', () => {
    const out = parseRxItems([{ drug: '', frequency: 'bd', durationDays: 5 }]);
    expect(out).toHaveProperty('error');
  });

  it('rejects an unknown frequency instead of silently dropping the schedule', () => {
    // Dropping it would leave the patient holding a medicine with no schedule.
    const out = parseRxItems([{ drug: 'Amoxicillin', frequency: 'twice' }]);
    expect(out).toHaveProperty('error');
  });

  it('rejects an unknown route', () => {
    expect(parseRxItems([{ drug: 'X', route: 'intrathecal' }])).toHaveProperty('error');
  });

  it('rejects an implausible duration as a typo guard', () => {
    expect(parseRxItems([{ drug: 'X', durationDays: 3000 }])).toHaveProperty('error');
    expect(parseRxItems([{ drug: 'X', durationDays: 0 }])).toHaveProperty('error');
    expect(parseRxItems([{ drug: 'X', durationDays: 365 }])).toHaveProperty('items');
  });

  it('rejects malformed JSON and non-lists', () => {
    expect(parseRxItems('{not json')).toHaveProperty('error');
    expect(parseRxItems({ drug: 'X' })).toHaveProperty('error');
  });

  it('caps the number of medicines', () => {
    const many = Array.from({ length: MAX_RX_ITEMS + 1 }, () => ({ drug: 'X' }));
    expect(parseRxItems(many)).toHaveProperty('error');
  });

  it('normalises blank optional fields to null, not empty string', () => {
    const out = parseRxItems([{ drug: 'X', strength: '  ', instructions: '' }]);
    expect(out).toEqual({
      items: [expect.objectContaining({ drug: 'X', strength: null, instructions: null })],
    });
  });

  it('trims the drug name so lookups and display agree', () => {
    const out = parseRxItems([{ drug: '  Amlodipine  ' }]);
    expect(out).toEqual({ items: [expect.objectContaining({ drug: 'Amlodipine' })] });
  });
});
