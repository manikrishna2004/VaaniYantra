// Patient age and date of birth.
//
// Dependency-free on purpose (like uhid-format.ts): the patient list, the
// booking drawer and the patient page are all client components and need these,
// and `@/lib/db` must never reach the browser bundle.
//
// THE TIMEZONE TRAP, SOLVED ONCE HERE
// A date of birth is a calendar date, not an instant. `new Date('1990-05-12')`
// parses as UTC midnight; render that in Asia/Kolkata and you still get 12 May,
// but let it round-trip through a local-time parse and it becomes 11 May. The
// bug ships silently and surfaces as a patient's birthday being wrong — later,
// on a printed prescription, in front of the patient.
//
// The rule, and every helper here obeys it:
//   write → parse YYYY-MM-DD to UTC midnight
//   read  → format with timeZone: 'UTC'
//
// Nobody should re-derive this. If you need a new DOB helper, add it here.

/** Oldest plausible patient. Anything beyond this is a typo, not a person. */
const MAX_AGE_YEARS = 130;

/**
 * Parse a `YYYY-MM-DD` date of birth to UTC midnight.
 *
 * Returns null for anything malformed, in the future, or implausibly old — a
 * mistyped year is far more likely than a 150-year-old patient, and a wrong DOB
 * silently corrupts every age-based clinical judgement downstream.
 */
export function parseDateOfBirth(input: string | null | undefined, now: Date = new Date()): Date | null {
  const raw = (input ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  const [y, m, d] = raw.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  // Catches 2026-02-30, which Date would silently roll into March.
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) return null;

  if (parsed.getTime() > now.getTime()) return null;
  const oldest = new Date(Date.UTC(now.getUTCFullYear() - MAX_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()));
  if (parsed.getTime() < oldest.getTime()) return null;

  return parsed;
}

/** Render a stored date of birth back as `YYYY-MM-DD`, for a date input or the API. */
export function formatDateOfBirth(dob: Date | string | null | undefined): string {
  if (!dob) return '';
  const d = typeof dob === 'string' ? new Date(dob) : dob;
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Whole years, for anything that needs a number rather than a label. */
export function ageInYears(dob: Date | string | null | undefined, now: Date = new Date()): number | null {
  const d = typeof dob === 'string' ? new Date(dob) : dob;
  if (!d || Number.isNaN(d.getTime())) return null;
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - d.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d.getUTCDate())) years -= 1;
  return years < 0 ? null : years;
}

/**
 * Age as a clinician would say it.
 *
 * Under two years it is given in MONTHS, and under one month in DAYS. This is
 * not cosmetic: paediatric dosing, developmental milestones and vaccination
 * schedules are all reckoned in months, and "1 year" spans a range of weight
 * and physiology that "14 months" does not.
 */
export function formatAge(dob: Date | string | null | undefined, now: Date = new Date()): string {
  const d = typeof dob === 'string' ? new Date(dob) : dob;
  if (!d || Number.isNaN(d.getTime())) return '';

  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 0) return '';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;

  const months = monthsBetween(d, now);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;

  const years = ageInYears(d, now) ?? 0;
  return `${years} year${years === 1 ? '' : 's'}`;
}

/** Compact form for a dense list or a search result: "34y", "18mo". */
export function formatAgeShort(dob: Date | string | null | undefined, now: Date = new Date()): string {
  const d = typeof dob === 'string' ? new Date(dob) : dob;
  if (!d || Number.isNaN(d.getTime())) return '';
  const months = monthsBetween(d, now);
  if (months < 0) return '';
  if (months < 24) return `${months}mo`;
  return `${ageInYears(d, now) ?? 0}y`;
}

function monthsBetween(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

/**
 * "34 years · Female" — the one-line demographic summary used in the patient
 * header, search results and the chatbot's context.
 */
export function describePatient(
  dob: Date | string | null | undefined,
  sex: string | null | undefined,
  now: Date = new Date(),
): string {
  const age = formatAge(dob, now);
  const label = sexLabel(sex);
  return [age, label].filter(Boolean).join(' · ');
}

// ── Sex ─────────────────────────────────────────────────────────────────────
// House convention: a `value`/`label` catalogue that validation.ts derives a
// zod enum from, exactly like AGENT_TYPES.

export const SEXES = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
] as const;

export type PatientSex = (typeof SEXES)[number]['value'];

export function sexLabel(value: string | null | undefined): string {
  return SEXES.find((s) => s.value === value)?.label ?? '';
}
