// Pure patient-number formatting. Dependency-free on purpose: the settings form
// is a client component and needs these, and `uhid.ts` next door imports Prisma.
//
// Shape: <PREFIX>-<6 zero-padded digits> → "SDC-000147". The prefix belongs to
// the org and is NOT stored inside the number, so re-branding a clinic never
// renumbers its patients — only how their number is displayed changes.
//
// No year segment on purpose. "SDC-2026-0147" reads as a registration year,
// which is wrong the moment a patient returns in a later year, and it breaks
// lexical sorting.

export const UHID_PAD = 6;
export const UHID_MAX_PREFIX = 6;
const DEFAULT_PREFIX = 'PT';

/** Derive a sensible default prefix from a clinic's name ("Smile Dental Care" → "SDC"). */
export function defaultUhidPrefix(orgName: string): string {
  const words = orgName
    .toUpperCase()
    // Apostrophes are dropped, not turned into separators: "St. Mary's Clinic"
    // is three words, so it should read SMC, not SMSC.
    .replace(/['’`]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return DEFAULT_PREFIX;
  // Multi-word names become initials (the usual clinic convention); a single
  // word is truncated instead, because "S" alone is not a useful prefix.
  const raw = words.length > 1 ? words.map((w) => w[0]).join('') : words[0];
  return raw.slice(0, UHID_MAX_PREFIX) || DEFAULT_PREFIX;
}

/** Clean a founder-typed prefix, or null when they left it blank. */
export function normalizeUhidPrefix(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned ? cleaned.slice(0, UHID_MAX_PREFIX) : null;
}

/** Compose a patient number from a prefix and a counter value. */
export function composeUhid(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(UHID_PAD, '0')}`;
}
