import { getPlatformConfig } from '@/lib/platform';

// Indian GST on SaaS subscriptions.
//
// Pricing is tax-EXCLUSIVE: the catalogue price is the taxable value and GST is
// added on top, so the plan prices and our revenue per plan are unchanged by
// switching tax on. A GST-registered customer reclaims it as input credit.
//
// Ships DISABLED. Charging GST without a registration is an offence, so this
// stays off until the founder enters a GSTIN in /admin — until then every
// computation returns zero tax and the invoice says so.
//
// Place of supply (s.12(2) IGST Act) decides the split, not the tax rate:
//   customer in the supplier's own state -> CGST + SGST, half the rate each
//   customer in any other state          -> IGST at the full rate
// Both come to the same total; getting the split wrong misfiles the return.
// With no customer address on record the place of supply is the supplier's
// location, which lands on CGST+SGST.

export const TAX_KEYS = {
  enabled: 'gst_enabled', // '1' once the GSTIN is real
  gstin: 'gst_number',
  rate: 'gst_rate', // percent; 18 for software/SaaS
  stateCode: 'gst_state_code', // supplier's GST state code
  legalName: 'gst_legal_name',
  address: 'gst_address',
} as const;

/** SAC for "software as a service" — printed on the invoice. */
export const SAC_CODE = '998314';

const DEFAULT_RATE = 18;
/** Andhra Pradesh — the registered place of business. */
const DEFAULT_STATE = '37';

export type TaxConfig = {
  enabled: boolean;
  gstin: string | null;
  rate: number;
  stateCode: string;
  legalName: string | null;
  address: string | null;
};

export type TaxBreakdown = {
  /** Pre-tax value — what the plan actually costs. */
  taxableInr: number;
  cgstInr: number;
  sgstInr: number;
  igstInr: number;
  totalTaxInr: number;
  /** What the customer is charged. */
  totalInr: number;
  rate: number;
  /**
   * 'intra' = CGST+SGST, 'inter' = IGST, 'export' = customer outside India
   * (zero-rated), 'none' = tax not being charged at all.
   */
  kind: 'intra' | 'inter' | 'export' | 'none';
};

export async function getTaxConfig(): Promise<TaxConfig> {
  const [enabled, gstin, rate, stateCode, legalName, address] = await Promise.all([
    getPlatformConfig(TAX_KEYS.enabled),
    getPlatformConfig(TAX_KEYS.gstin),
    getPlatformConfig(TAX_KEYS.rate),
    getPlatformConfig(TAX_KEYS.stateCode),
    getPlatformConfig(TAX_KEYS.legalName),
    getPlatformConfig(TAX_KEYS.address),
  ]);
  const parsedRate = Number(rate);
  return {
    // Belt and braces: a stray enabled flag with no GSTIN must not start
    // charging tax we cannot legally collect.
    enabled: enabled === '1' && Boolean(gstin?.trim()),
    gstin: gstin?.trim() || null,
    rate: Number.isFinite(parsedRate) && parsedRate > 0 && parsedRate <= 28 ? parsedRate : DEFAULT_RATE,
    stateCode: stateCode?.trim() || DEFAULT_STATE,
    legalName: legalName?.trim() || null,
    address: address?.trim() || null,
  };
}

/** Round to paise. GST rounding is per-component, then summed. */
const paise = (n: number) => Math.round(n * 100) / 100;

/**
 * Split `amountInr` (the pre-tax price) into its tax components.
 * `customerStateCode` is the first two digits of the customer's GSTIN, or their
 * chosen state; undefined means "no address on record".
 * `customerCountry` is an ISO-3166 alpha-2 code; anything other than India makes
 * this an export of service, which carries no GST. Undefined means India, so
 * existing domestic callers keep their behaviour.
 */
export function computeTax(
  cfg: TaxConfig,
  amountInr: number,
  customerStateCode?: string | null,
  customerCountry?: string | null,
): TaxBreakdown {
  const taxable = paise(amountInr);
  const exported = Boolean(customerCountry) && customerCountry !== 'IN';
  if (!cfg.enabled || taxable <= 0 || exported) {
    return {
      taxableInr: taxable,
      cgstInr: 0,
      sgstInr: 0,
      igstInr: 0,
      totalTaxInr: 0,
      totalInr: taxable,
      rate: 0,
      // Export is zero-rated rather than untaxed, and the invoice says so —
      // but only when we're actually GST-registered; otherwise no tax line
      // belongs on the invoice at all.
      kind: exported && cfg.enabled && taxable > 0 ? 'export' : 'none',
    };
  }

  const total = paise((taxable * cfg.rate) / 100);
  const interState = Boolean(customerStateCode) && customerStateCode !== cfg.stateCode;

  if (interState) {
    return {
      taxableInr: taxable,
      cgstInr: 0,
      sgstInr: 0,
      igstInr: total,
      totalTaxInr: total,
      totalInr: paise(taxable + total),
      rate: cfg.rate,
      kind: 'inter',
    };
  }

  // Halve, then make the second component absorb the rounding remainder so the
  // parts always sum to the total (₹0.01 discrepancies fail GST reconciliation).
  const cgst = paise(total / 2);
  const sgst = paise(total - cgst);
  return {
    taxableInr: taxable,
    cgstInr: cgst,
    sgstInr: sgst,
    igstInr: 0,
    totalTaxInr: total,
    totalInr: paise(taxable + total),
    rate: cfg.rate,
    kind: 'intra',
  };
}

/** GSTINs start with the two-digit state code. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? '').trim().toUpperCase();
  return /^\d{2}[A-Z0-9]{13}$/.test(g) ? g.slice(0, 2) : null;
}

/**
 * Structural GSTIN check: 2-digit state, 10-char PAN, entity digit, 'Z', and a
 * checksum character. Deliberately not a checksum validation — a wrong-but-
 * well-formed GSTIN is the customer's responsibility, and rejecting valid edge
 * cases is worse than accepting a typo.
 */
export function isValidGstinFormat(gstin: string): boolean {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]$/.test(gstin.trim().toUpperCase());
}

/** GST state codes, for the customer's place-of-supply selector. */
export const GST_STATES: { code: string; name: string }[] = [
  { code: '01', name: 'Jammu & Kashmir' }, { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' }, { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' }, { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' }, { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' }, { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' }, { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' }, { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' }, { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' }, { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' }, { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' }, { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' }, { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu' },
  { code: '27', name: 'Maharashtra' }, { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' }, { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' }, { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' }, { code: '35', name: 'Andaman & Nicobar Islands' },
  { code: '36', name: 'Telangana' }, { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
];

export const stateName = (code: string | null | undefined) =>
  GST_STATES.find((s) => s.code === code)?.name ?? null;
