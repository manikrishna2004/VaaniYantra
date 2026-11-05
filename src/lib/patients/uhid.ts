import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { composeUhid, defaultUhidPrefix, normalizeUhidPrefix } from '@/lib/patients/uhid-format';

// Patient numbers (UHID) — the short, human-readable identity a clinic actually
// uses: "SDC-000147". Staff read it out on the phone, write it on a file, and
// search by it. Our cuids are none of those things.
//
// The formatting rules live in ./uhid-format so the settings form can import
// them without dragging Prisma into the browser bundle.
export { composeUhid, defaultUhidPrefix, normalizeUhidPrefix } from '@/lib/patients/uhid-format';

/**
 * Allocate the next patient number for an org.
 *
 * The counter is bumped with a single atomic UPDATE … RETURNING rather than a
 * read-then-write, so two front-desk staff (or two agents on two calls) saving
 * a new patient at the same instant always get different numbers, with no retry
 * loop and no advisory lock. The @@unique([orgId, uhid]) constraint backs it up.
 *
 * Deliberately NOT called from inside claimSlot(): that already holds a
 * per-slot advisory lock, and taking an org-wide row lock inside it would
 * serialise every booking for the clinic behind this counter.
 */
export async function allocateUhid(orgId: string, tx?: Prisma.TransactionClient): Promise<string> {
  const db = tx ?? prisma;
  const rows = await db.$queryRaw<{ uhidSeq: number; uhidPrefix: string | null; name: string }[]>`
    UPDATE "Organization"
       SET "uhidSeq" = "uhidSeq" + 1
     WHERE "id" = ${orgId}
    RETURNING "uhidSeq", "uhidPrefix", "name"
  `;
  const row = rows[0];
  if (!row) throw new Error(`allocateUhid: no organization ${orgId}`);

  const prefix = normalizeUhidPrefix(row.uhidPrefix) ?? defaultUhidPrefix(row.name);
  return composeUhid(prefix, row.uhidSeq);
}

/**
 * Return a contact's number, allocating one if it is somehow missing.
 *
 * Covers two real cases: rows created before patient numbering existed and not
 * yet reached by the backfill, and the deploy window where an old process is
 * still creating contacts without one. Everything that displays a UHID goes
 * through here so a blank never reaches a clinic's screen.
 */
export async function ensureUhid(contactId: string): Promise<string | null> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { uhid: true, orgId: true },
  });
  if (!contact) return null;
  if (contact.uhid) return contact.uhid;

  const uhid = await allocateUhid(contact.orgId);
  try {
    await prisma.contact.update({ where: { id: contactId }, data: { uhid } });
    return uhid;
  } catch {
    // Lost a race with another filler — whatever landed is authoritative.
    const again = await prisma.contact.findUnique({ where: { id: contactId }, select: { uhid: true } });
    return again?.uhid ?? null;
  }
}
