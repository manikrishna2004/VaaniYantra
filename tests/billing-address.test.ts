import { describe, it, expect } from 'vitest';

// The billing identity collected at checkout. These cover the two things that
// can go wrong quietly: an invoice printing a half-address, and place of supply
// disagreeing with the GSTIN (which would put the wrong GST split on the bill).

import {
  normalizeBillingAddress,
  validateBillingAddress,
  composeBillingAddress,
  normalizePhone,
  isValidPhone,
} from '@/lib/billing-address';

const full = {
  billingName: '  Acme Foods Pvt Ltd ',
  billingLine1: '3-60 Balijipalem',
  billingLine2: '',
  billingCity: 'Narsipatnam',
  billingPostalCode: '531114',
  billingCountry: 'IN',
  gstStateCode: '37',
  gstin: '',
};

const foreign = {
  billingName: 'Acme LLC',
  billingLine1: '410 Terry Ave N',
  billingCity: 'Seattle',
  billingPostalCode: '98109',
  billingCountry: 'US',
  billingRegion: 'Washington',
};

describe('normalizeBillingAddress', () => {
  it('trims fields and blanks empties out to null', () => {
    const a = normalizeBillingAddress(full);
    expect(a.billingName).toBe('Acme Foods Pvt Ltd');
    expect(a.billingLine2).toBeNull();
    expect(a.gstin).toBeNull();
  });

  it('takes place of supply from the GSTIN, overriding the picked state', () => {
    const a = normalizeBillingAddress({ ...full, gstStateCode: '27', gstin: '37abcde1234f1z5' });
    expect(a.gstin).toBe('37ABCDE1234F1Z5');
    expect(a.gstStateCode).toBe('37'); // Andhra Pradesh, from the GSTIN
  });

  it('ignores a state code that is not a real GST state', () => {
    expect(normalizeBillingAddress({ ...full, gstStateCode: '99' }).gstStateCode).toBeNull();
  });

  it('composes the printable address block', () => {
    expect(normalizeBillingAddress(full).billingAddress).toBe(
      '3-60 Balijipalem\nNarsipatnam, Andhra Pradesh - 531114\nIndia',
    );
  });

  it('defaults to India when no country is given', () => {
    expect(normalizeBillingAddress({}).billingCountry).toBe('IN');
    expect(normalizeBillingAddress({ billingCountry: 'ZZ' }).billingCountry).toBe('IN');
  });
});

describe('normalizeBillingAddress — outside India', () => {
  it('uses the free-text region and the country name in the address block', () => {
    expect(normalizeBillingAddress(foreign).billingAddress).toBe(
      '410 Terry Ave N\nSeattle, Washington - 98109\nUnited States',
    );
  });

  it('drops the Indian tax identity rather than keeping it as dead data', () => {
    const a = normalizeBillingAddress({ ...foreign, gstin: '37ABCDE1234F1Z5', gstStateCode: '37' });
    expect(a.gstin).toBeNull();
    expect(a.gstStateCode).toBeNull();
  });

  it('drops the free-text region for an Indian address', () => {
    expect(normalizeBillingAddress({ ...full, billingRegion: 'Washington' }).billingRegion).toBeNull();
  });
});

describe('composeBillingAddress', () => {
  it('returns null when only the country would be printed', () => {
    expect(
      composeBillingAddress({
        billingLine1: null,
        billingLine2: null,
        billingCity: null,
        billingPostalCode: null,
        billingCountry: 'IN',
        billingRegion: null,
        gstStateCode: null,
      }),
    ).toBeNull();
  });
});

describe('validateBillingAddress', () => {
  it('accepts a complete address in strict mode', () => {
    expect(validateBillingAddress(normalizeBillingAddress(full), { strict: true })).toEqual({});
  });

  it('names every missing field before payment', () => {
    const errors = validateBillingAddress(normalizeBillingAddress({}), { strict: true });
    expect(Object.keys(errors).sort()).toEqual([
      'billingCity',
      'billingLine1',
      'billingName',
      'billingPostalCode',
      'gstStateCode',
    ]);
  });

  it('lets a partial address be saved outside checkout', () => {
    expect(validateBillingAddress(normalizeBillingAddress({ billingCity: 'Vizag' }), { strict: false })).toEqual({});
  });

  it('rejects a malformed GSTIN and PIN either way', () => {
    const a = normalizeBillingAddress({ ...full, gstin: '37ABCDE1234F1Z', billingPostalCode: '53111' });
    const errors = validateBillingAddress(a, { strict: false });
    expect(errors.gstin).toBeTruthy();
    expect(errors.billingPostalCode).toBeTruthy();
  });

  it('accepts a complete foreign address without state or postal code', () => {
    const a = normalizeBillingAddress({ ...foreign, billingPostalCode: '', billingRegion: '' });
    expect(validateBillingAddress(a, { strict: true })).toEqual({});
  });

  it('does not impose the 6-digit PIN rule outside India', () => {
    const a = normalizeBillingAddress({ ...foreign, billingPostalCode: 'SW1A 1AA' });
    expect(validateBillingAddress(a, { strict: true })).toEqual({});
  });
});

describe('phone', () => {
  it('strips the +91 / 0 prefix and formatting for India', () => {
    expect(normalizePhone('+91 98765 43210', 'IN')).toBe('9876543210');
    expect(normalizePhone('098765-43210', 'IN')).toBe('9876543210');
  });

  it('keeps the country code and the plus outside India', () => {
    // Cashfree rejects an international number without the leading '+'.
    expect(normalizePhone('+1 (206) 555-0142', 'US')).toBe('+12065550142');
    expect(normalizePhone('1 206 555 0142', 'US')).toBe('+12065550142');
    expect(normalizePhone('', 'US')).toBe('');
  });

  it('only accepts a 10-digit mobile for India', () => {
    expect(isValidPhone('9876543210', 'IN')).toBe(true);
    expect(isValidPhone('1234543210', 'IN')).toBe(false);
    expect(isValidPhone('98765432', 'IN')).toBe(false);
  });

  it('requires the plus and a plausible length elsewhere', () => {
    expect(isValidPhone('+12065550142', 'US')).toBe(true);
    expect(isValidPhone('+442071838750', 'GB')).toBe(true);
    // Cashfree rejects these outright, so they must not reach it.
    expect(isValidPhone('12065550142', 'US')).toBe(false);
    expect(isValidPhone('+12345', 'US')).toBe(false);
  });

  it('round-trips what checkout actually sends to the gateway', () => {
    for (const [raw, country, expected] of [
      ['+1 (206) 555-0142', 'US', '+12065550142'],
      ['+44 20 7183 8750', 'GB', '+442071838750'],
      ['+91 98765 43210', 'IN', '9876543210'],
    ] as const) {
      const normalized = normalizePhone(raw, country);
      expect(normalized).toBe(expected);
      expect(isValidPhone(normalized, country)).toBe(true);
    }
  });

  it('treats a missing country as India', () => {
    expect(isValidPhone('9876543210')).toBe(true);
    expect(isValidPhone('12065550142')).toBe(false);
  });
});
