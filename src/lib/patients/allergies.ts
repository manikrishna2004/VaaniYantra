import type { Allergy, Contact } from '@prisma/client';

// Allergy status — three states, and the distinction between them is the point.
//
//   unknown     nobody has asked. NOT the same as "none".
//   none-known  someone asked and the patient reported nothing.
//   known       there is at least one recorded allergy.
//
// Collapsing `unknown` into `none-known` is the error that matters. A blank
// allergy list read as "no allergies" is how a patient gets prescribed the drug
// that put them in hospital last year — and it is exactly the mistake a language
// model makes when handed a silent gap, which is why the chatbot block below
// spells the state out rather than leaving it to be inferred.
//
// This mirrors the reasoning already applied to VisitsResult, where
// `unavailable` deliberately cannot be confused with `empty`.

export const ALLERGY_SEVERITIES = [
  { value: 'mild', label: 'Mild' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
] as const;

export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number]['value'];

export function severityLabel(value: string | null | undefined): string {
  return ALLERGY_SEVERITIES.find((s) => s.value === value)?.label ?? '';
}

/** Sort order for display: the dangerous ones first. */
const SEVERITY_RANK: Record<string, number> = { severe: 0, moderate: 1, mild: 2 };

export type AllergyItem = {
  id: string;
  substance: string;
  reaction: string | null;
  severity: string;
  recordedAt: string;
};

export type AllergyStatus =
  | { state: 'unknown' }
  | { state: 'none-known'; reviewedAt: string }
  | { state: 'known'; reviewedAt: string | null; items: AllergyItem[] };

/**
 * Resolve a patient's allergy status from their record.
 *
 * Note the fourth combination: rows exist but `allergiesReviewedAt` is null,
 * which happens when a clinic's own system pushed allergies in before anyone
 * reviewed them here. That resolves to `known` with the most recent record date
 * standing in — it must never downgrade to `unknown`, because recorded
 * allergies are recorded allergies however they arrived.
 */
export function allergyStatus(
  contact: Pick<Contact, 'allergiesReviewedAt'>,
  allergies: Allergy[],
): AllergyStatus {
  const active = allergies
    .filter((a) => !a.retiredAt)
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        b.recordedAt.getTime() - a.recordedAt.getTime(),
    );

  if (active.length > 0) {
    const fallback = active.reduce<Date>((max, a) => (a.recordedAt > max ? a.recordedAt : max), active[0].recordedAt);
    return {
      state: 'known',
      reviewedAt: (contact.allergiesReviewedAt ?? fallback).toISOString(),
      items: active.map((a) => ({
        id: a.id,
        substance: a.substance,
        reaction: a.reaction,
        severity: a.severity,
        recordedAt: a.recordedAt.toISOString(),
      })),
    };
  }

  if (contact.allergiesReviewedAt) {
    return { state: 'none-known', reviewedAt: contact.allergiesReviewedAt.toISOString() };
  }
  return { state: 'unknown' };
}

/** One-line summary for a header or a list row. */
export function summariseAllergies(status: AllergyStatus): string {
  if (status.state === 'unknown') return 'Allergies not recorded';
  if (status.state === 'none-known') return 'No known allergies';
  return status.items.map((a) => a.substance).join(', ');
}

/**
 * The allergy block injected into the chatbot's context.
 *
 * The `unknown` case carries an explicit instruction because a model handed an
 * empty list will helpfully fill the silence — and "you have no allergies" from
 * a clinic's own chatbot is a statement a patient may act on.
 */
export function formatAllergyBlock(status: AllergyStatus): string {
  if (status.state === 'unknown') {
    return (
      '\n\nAllergies: NOT RECORDED — no allergy history has been taken for this patient. ' +
      'Do NOT tell them they have no allergies. If they ask, say the clinic has not recorded ' +
      'their allergy history yet and they should confirm it with the clinic.'
    );
  }
  if (status.state === 'none-known') {
    return '\n\nAllergies: none known (recorded by the clinic).';
  }
  const items = status.items
    .map((a) => `${a.substance} (${severityLabel(a.severity) || a.severity}${a.reaction ? ` — ${a.reaction}` : ''})`)
    .join('; ');
  return (
    `\n\nAllergies: ${items}. ` +
    'If the patient asks about a medicine that appears here, do not reassure them — tell them to speak to the clinic.'
  );
}
