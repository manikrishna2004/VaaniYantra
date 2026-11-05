import { describe, it, expect } from 'vitest';
import {
  computeTax,
  stateCodeFromGstin,
  isValidGstinFormat,
  GST_STATES,
  type TaxConfig,
} from '@/lib/billing/tax';
import { financialYear } from '@/lib/billing/invoice';

// GST figures end up on statutory documents, so the split and the rounding both
// have to be exact — components that don't sum to the total fail reconciliation.

const cfg = (over: Partial<TaxConfig> = {}): TaxConfig => ({
  enabled: true,
  gstin: '37ABCDE1234F1Z5',
  rate: 18,
  stateCode: '37', // Andhra Pradesh
  legalName: 'VaaniYantra',
  address: 'Narsipatnam, AP',
  ...over,
});

describe('computeTax — disabled', () => {
  it('charges nothing and leaves the price untouched when GST is off', () => {
    const t = computeTax(cfg({ enabled: false }), 999, '27');
    expect(t).toMatchObject({ totalTaxInr: 0, totalInr: 999, kind: 'none', rate: 0 });
  });
});

describe('computeTax — place of supply', () => {
  it('splits into CGST + SGST within the supplier’s own state', () => {
    const t = computeTax(cfg(), 1000, '37');
    expect(t.kind).toBe('intra');
    expect(t.cgstInr).toBe(90);
    expect(t.sgstInr).toBe(90);
    expect(t.igstInr).toBe(0);
    expect(t.totalInr).toBe(1180);
  });

  it('charges IGST for another state', () => {
    const t = computeTax(cfg(), 1000, '27'); // Maharashtra
    expect(t.kind).toBe('inter');
    expect(t.igstInr).toBe(180);
    expect(t.cgstInr + t.sgstInr).toBe(0);
    expect(t.totalInr).toBe(1180);
  });

  it('treats an unknown customer state as the supplier’s own location', () => {
    // With no address on record the place of supply is the supplier's.
    expect(computeTax(cfg(), 1000, null).kind).toBe('intra');
    expect(computeTax(cfg(), 1000, undefined).kind).toBe('intra');
  });

  it('reaches the same total either way', () => {
    expect(computeTax(cfg(), 999, '37').totalInr).toBe(computeTax(cfg(), 999, '27').totalInr);
  });
});

describe('computeTax — export of service', () => {
  it('charges no GST to a customer outside India', () => {
    const t = computeTax(cfg(), 1000, null, 'US');
    expect(t).toMatchObject({ totalTaxInr: 0, totalInr: 1000, kind: 'export', rate: 0 });
  });

  it('ignores a stale Indian state on a foreign address', () => {
    expect(computeTax(cfg(), 1000, '37', 'AE').kind).toBe('export');
  });

  it('keeps GST for India, whether the country is stated or assumed', () => {
    expect(computeTax(cfg(), 1000, '37', 'IN').kind).toBe('intra');
    expect(computeTax(cfg(), 1000, '37').kind).toBe('intra');
  });

  it('says "none", not "export", while we are not GST-registered', () => {
    // No tax line belongs on the invoice at all until the GSTIN is real.
    expect(computeTax(cfg({ enabled: false }), 1000, null, 'US').kind).toBe('none');
  });
});

describe('computeTax — rounding', () => {
  it('makes CGST and SGST sum exactly to the total tax', () => {
    // 999 * 18% = 179.82, which halves to 89.91 exactly.
    const t = computeTax(cfg(), 999, '37');
    expect(t.cgstInr + t.sgstInr).toBe(t.totalTaxInr);
    expect(t.totalTaxInr).toBe(179.82);
  });

  it('absorbs an odd remainder rather than losing a paisa', () => {
    // A tax that cannot halve cleanly: 0.01 splits 0.01/0.00, not 0.005 each.
    const t = computeTax(cfg({ rate: 1 }), 1, '37');
    expect(t.cgstInr + t.sgstInr).toBe(t.totalTaxInr);
  });

  it('keeps taxable + tax === total across many amounts', () => {
    for (const amt of [1, 10, 99.99, 499.5, 999, 4999, 14999]) {
      for (const state of ['37', '27']) {
        const t = computeTax(cfg(), amt, state);
        expect(Math.round((t.taxableInr + t.totalTaxInr) * 100) / 100).toBe(t.totalInr);
      }
    }
  });

  it('taxes the discounted amount, not the list price', () => {
    // A ₹10 promo price must be taxed on ₹10.
    const t = computeTax(cfg(), 10, '37');
    expect(t.taxableInr).toBe(10);
    expect(t.totalInr).toBe(11.8);
  });
});

describe('stateCodeFromGstin', () => {
  it('takes the state from the leading two digits', () => {
    expect(stateCodeFromGstin('37ABCDE1234F1Z5')).toBe('37');
    expect(stateCodeFromGstin('27ABCDE1234F1Z5')).toBe('27');
  });

  it('returns null for anything malformed', () => {
    expect(stateCodeFromGstin('')).toBeNull();
    expect(stateCodeFromGstin(null)).toBeNull();
    expect(stateCodeFromGstin('nonsense')).toBeNull();
  });
});

describe('isValidGstinFormat', () => {
  it('accepts a well-formed GSTIN in any case', () => {
    expect(isValidGstinFormat('37ABCDE1234F1Z5')).toBe(true);
    expect(isValidGstinFormat(' 37abcde1234f1z5 ')).toBe(true);
  });

  it('rejects wrong lengths and wrong shapes', () => {
    expect(isValidGstinFormat('37ABCDE1234F1Z')).toBe(false);
    expect(isValidGstinFormat('ABCDE1234F1Z5')).toBe(false);
    expect(isValidGstinFormat('')).toBe(false);
  });
});

describe('GST_STATES', () => {
  it('has unique codes and includes the supplier state', () => {
    const codes = GST_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('37');
  });
});

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T00:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-04-01T00:00:00Z'))).toBe('2027-28');
  });

  it('puts January in the year that began the previous April', () => {
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
  });
});
