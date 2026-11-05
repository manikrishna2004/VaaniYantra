import type { Contact, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

// Households — several patients sharing one mobile number.
//
// Indian clinics see this constantly: a mother books for three children,
// elderly parents use their son's phone. Before this, one number meant one
// Contact, so those people shared a single medical record — one allergy list,
// one age, one chatbot session covering all of them.
//
// THE MODEL
//   dependentKey ""   → the household primary, the number's owner
//   dependentKey cuid → a dependent, with guardianContactId pointing at the primary
//
// INVARIANTS, held here rather than in the schema:
//   • a dependent shares its guardian's orgId, workspaceId and phone
//   • exactly one level — a dependent may never have dependents of its own
//   • dependentKey is immutable once written; changing it would orphan history
//
// WHY A SENTINEL RATHER THAN NULL
// `""` keeps `@@unique([orgId, phone, dependentKey])` a real constraint. With
// NULL, Postgres treats every row as distinct and the primary slot would not be
// protected at all — and Prisma's compound-unique `where` input rejects null, so
// upsertContact could not express the lookup.

/** The household primary's sentinel `dependentKey`. */
export const PRIMARY_KEY = '';

export function isPrimary(contact: Pick<Contact, 'dependentKey'>): boolean {
  return contact.dependentKey === PRIMARY_KEY;
}

/**
 * Every patient this contact may see: themselves, plus anyone they are guardian
 * for.
 *
 * Deliberately NOT "everyone on this phone number". A dependent must not read a
 * sibling's records simply because they share a handset — only the guardian
 * looks downward.
 */
export async function viewableContactIds(contact: Contact): Promise<string[]> {
  if (!isPrimary(contact)) return [contact.id];
  const dependents = await prisma.contact.findMany({
    where: { orgId: contact.orgId, guardianContactId: contact.id },
    select: { id: true },
  });
  return [contact.id, ...dependents.map((d) => d.id)];
}

/**
 * Everyone reachable from a phone number within one clinic, primary first.
 *
 * Used by the OTP flow to build the "who is this for?" list. Blocked patients
 * are excluded — a blocked son must not appear, but he also must not stop his
 * mother signing in.
 */
export async function householdByPhone(orgId: string, phone: string) {
  return prisma.contact.findMany({
    where: { orgId, phone, portalRevokedAt: null },
    // "" sorts before any cuid, so the primary is always first.
    orderBy: [{ dependentKey: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Pick which member of a household a spoken name refers to.
 *
 * ⚠ THIS MAY SELECT. IT MAY NEVER CREATE. That asymmetry is the whole safety
 * argument: choosing the wrong existing family member puts an appointment on
 * the wrong file, which the front desk fixes in one click. Creating a patient
 * from a misheard name puts a permanent duplicate — with its own UHID and its
 * own empty allergy list — into the clinic's records forever.
 *
 * Returns undefined unless exactly one member matches. Zero matches or an
 * ambiguous two both fall back to the primary, because a confident wrong answer
 * is worse than an obvious default the clinic can see and correct.
 */
export function matchHouseholdMember<T extends { id: string; name: string }>(
  household: T[],
  spokenName: string | null | undefined,
): T | undefined {
  const spoken = normalizeName(spokenName);
  if (!spoken || household.length < 2) return undefined;

  const exact = household.filter((m) => normalizeName(m.name) === spoken);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined; // genuinely ambiguous — do not guess

  // First given name, allowing one character of slop for speech recognition.
  const spokenFirst = spoken.split(' ')[0];
  const near = household.filter((m) => {
    const first = normalizeName(m.name).split(' ')[0];
    return first === spokenFirst || levenshteinAtMost1(first, spokenFirst);
  });
  return near.length === 1 ? near[0] : undefined;
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when one edit (insert, delete or substitute) turns a into b. */
function levenshteinAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  // Too short to tolerate an edit — "Ram" and "Sam" are different people.
  if (Math.min(a.length, b.length) < 4) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Where a NEW patient on this number belongs.
 *
 * The first person on a number is the household primary. Anyone after them is a
 * dependent of that primary, with their own slot, their own UHID and their own
 * allergy list — never a replacement, and never merged.
 *
 * Returns the fields to spread into a `contact.create`.
 */
export async function newHouseholdSlot(
  orgId: string,
  phone: string,
): Promise<{ dependentKey: string; guardianContactId: string | null }> {
  const primary = await prisma.contact.findFirst({
    where: { orgId, phone, dependentKey: PRIMARY_KEY },
    select: { id: true },
  });
  if (!primary) return { dependentKey: PRIMARY_KEY, guardianContactId: null };
  // A cuid rather than a counter: the value is never displayed and never parsed,
  // it only has to be unique within the number.
  return { dependentKey: crypto.randomUUID(), guardianContactId: primary.id };
}

/**
 * The appointment filter for a signed-in patient.
 *
 * Two legs, and the difference between them is the whole point:
 *
 *   • `contactId in (viewable)` — the authoritative link. Once an appointment
 *     names a patient, that is who it belongs to.
 *
 *   • `contactId is NULL AND customerNumber = phone` — legacy rows only. Before
 *     appointments were linked to patients they were matched by comparing phone
 *     strings, and rows created back then have no link to repair.
 *
 * The `contactId: null` guard on the second leg is load-bearing. Without it, a
 * LINKED appointment would be visible to anyone sharing the number — which is a
 * lateral read between siblings the moment a household has more than one member.
 *
 * Only the primary gets the legacy leg. A dependent can only have been created
 * after households shipped, so it cannot have legitimate unlinked rows, and
 * granting it the phone leg would hand it the whole family's old appointments.
 */
export async function appointmentScope(contact: Contact): Promise<Prisma.AppointmentWhereInput> {
  const viewable = await viewableContactIds(contact);
  return {
    orgId: contact.orgId,
    OR: [
      { contactId: { in: viewable } },
      ...(isPrimary(contact) ? [{ contactId: null, customerNumber: contact.phone }] : []),
    ],
  };
}
