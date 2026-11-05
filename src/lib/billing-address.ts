import { GST_STATES, isValidGstinFormat, stateCodeFromGstin, stateName } from '@/lib/billing/tax';
import { INDIA, isCountryCode, countryName, isIndia } from '@/lib/countries';

// The org's billing identity, as collected on the checkout page.
//
// Two representations are kept on Organization: the structured fields (so the
// checkout form can be pre-filled on renewal) and `billingAddress`, the single
// printable block the tax invoice renders. Composing one from the other happens
// here so the two can never drift.
//
// India is the only country with GST rules to honour — a GSTIN, a state-driven
// place of supply, a 6-digit PIN. Everywhere else the region is free text, there
// is no tax identity, and the sale is an export of service.

export type BillingAddressInput = {
  billingName?: string;
  billingLine1?: string;
  billingLine2?: string;
  billingCity?: string;
  billingPostalCode?: string;
  billingCountry?: string;
  billingRegion?: string;
  gstStateCode?: string;
  gstin?: string;
};

export type NormalizedBillingAddress = {
  billingName: string | null;
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingPostalCode: string | null;
  billingCountry: string;
  billingRegion: string | null;
  gstStateCode: string | null;
  gstin: string | null;
  billingAddress: string | null;
};

/** Orgs that predate the country selector are Indian. */
export const DEFAULT_COUNTRY = INDIA;

/** The printable "billed to" block, minus the name (the invoice prints that). */
export function composeBillingAddress(a: {
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingPostalCode: string | null;
  billingCountry: string;
  billingRegion: string | null;
  gstStateCode: string | null;
}): string | null {
  const region = isIndia(a.billingCountry) ? stateName(a.gstStateCode) : a.billingRegion;
  const cityLine = [a.billingCity, region].filter(Boolean).join(', ');
  const withPostal = [cityLine, a.billingPostalCode].filter(Boolean).join(' - ');
  const lines = [
    a.billingLine1,
    a.billingLine2,
    withPostal,
    countryName(a.billingCountry) ?? a.billingCountry,
  ].filter((l): l is string => Boolean(l && l.trim()));
  // The country alone is not an address.
  return lines.length > 1 ? lines.join('\n') : null;
}

const clean = (v: string | undefined) => (v ?? '').trim() || null;

/**
 * Trim, upper-case the GSTIN, and settle place of supply. A GSTIN carries its
 * own state in the first two digits and that is authoritative — prefer it over
 * the dropdown so the two can't disagree on the invoice. Outside India the GST
 * fields are dropped entirely rather than kept as dead data.
 */
export function normalizeBillingAddress(body: BillingAddressInput): NormalizedBillingAddress {
  const requested = (body.billingCountry ?? '').trim().toUpperCase();
  const billingCountry = isCountryCode(requested) ? requested : DEFAULT_COUNTRY;
  const indian = isIndia(billingCountry);

  const gstin = indian ? (body.gstin ?? '').trim().toUpperCase() || null : null;
  const chosen = (body.gstStateCode ?? '').trim();
  const gstStateCode = indian
    ? (stateCodeFromGstin(gstin) ?? (GST_STATES.some((s) => s.code === chosen) ? chosen : null))
    : null;

  const fields = {
    billingName: clean(body.billingName),
    billingLine1: clean(body.billingLine1),
    billingLine2: clean(body.billingLine2),
    billingCity: clean(body.billingCity),
    billingPostalCode: clean(body.billingPostalCode),
    billingCountry,
    billingRegion: indian ? null : clean(body.billingRegion),
    gstStateCode,
    gstin,
  };
  return { ...fields, billingAddress: composeBillingAddress(fields) };
}

/**
 * Field-level errors, keyed by form field so the checkout page can mark the
 * offending input. `strict` is for checkout, where a complete address is
 * required before we charge anyone; the settings card saves partial details.
 */
export function validateBillingAddress(
  a: NormalizedBillingAddress,
  { strict }: { strict: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const indian = isIndia(a.billingCountry);

  if (a.gstin && !isValidGstinFormat(a.gstin)) {
    errors.gstin = 'That GSTIN doesn’t look right — it should be 15 characters, e.g. 37ABCDE1234F1Z5.';
  }
  // Only India's PIN has a shape we can rely on; postal codes elsewhere range
  // from 3 characters to alphanumeric, so only length is worth checking.
  if (a.billingPostalCode && indian && !/^\d{6}$/.test(a.billingPostalCode)) {
    errors.billingPostalCode = 'Enter a 6-digit PIN code.';
  }
  if (a.billingPostalCode && !indian && a.billingPostalCode.length > 12) {
    errors.billingPostalCode = 'That postal code is too long.';
  }
  if (!strict) return errors;

  if (!a.billingName) errors.billingName = 'Enter the name this should be billed to.';
  if (!a.billingLine1) errors.billingLine1 = 'Enter your street address.';
  if (!a.billingCity) errors.billingCity = 'Enter your city.';
  if (indian) {
    if (!a.gstStateCode) errors.gstStateCode = 'Select your state.';
    if (!a.billingPostalCode) errors.billingPostalCode = 'Enter a 6-digit PIN code.';
  }
  return errors;
}

/**
 * The shape Cashfree accepts for `customer_phone`.
 *
 * India is the bare 10-digit mobile, so a +91 / leading 0 is stripped. Every
 * other country MUST carry the `+` — verified against the live API, which
 * rejects "12065550142" ("should be a valid phone number … International
 * +16014635923") and accepts "+12065550142". Dropping the plus is the
 * difference between a working checkout and none at all.
 */
export function normalizePhone(phone: string | undefined | null, country?: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (isIndia(country ?? DEFAULT_COUNTRY)) return digits.replace(/^(?:91|0)(?=\d{10}$)/, '');
  return digits ? `+${digits}` : '';
}

/** Indian mobiles have a fixed shape; elsewhere only a plausible length. */
export function isValidPhone(phone: string, country?: string | null): boolean {
  return isIndia(country ?? DEFAULT_COUNTRY)
    ? /^[6-9]\d{9}$/.test(phone)
    : /^\+\d{7,15}$/.test(phone);
}
