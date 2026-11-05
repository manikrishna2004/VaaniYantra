/**
 * One-off backfill for patient numbers (UHID), run after the schema push.
 *
 *   npx tsx scripts/backfill-uhid.ts          # dry run — prints what it would do
 *   npx tsx scripts/backfill-uhid.ts --apply  # write
 *
 * Two passes:
 *   1. Every Contact without a `uhid` gets one, per org, in registration order,
 *      so the oldest patient is number 1. Organization.uhidSeq is then set past
 *      the highest number issued.
 *   2. Every Appointment without a `contactId` is linked to its patient by the
 *      phone match the app itself used before the two were related, and its
 *      `patientNo` snapshot is filled in.
 *
 * Safe to re-run: both passes skip rows that already have their values, so an
 * interrupted run just needs running again.
 */
import { PrismaClient } from '@prisma/client';
import { composeUhid, defaultUhidPrefix, normalizeUhidPrefix } from '../src/lib/patients/uhid-format';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '▶ applying' : '▶ dry run (pass --apply to write)');

  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, uhidPrefix: true, uhidSeq: true },
    orderBy: { createdAt: 'asc' },
  });

  let numbered = 0;
  let linked = 0;

  for (const org of orgs) {
    const prefix = normalizeUhidPrefix(org.uhidPrefix) ?? defaultUhidPrefix(org.name);

    // ── Pass 1: patient numbers ───────────────────────────────────────────
    const contacts = await prisma.contact.findMany({
      where: { orgId: org.id, uhid: null },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });

    let seq = org.uhidSeq;
    for (const c of contacts) {
      seq += 1;
      const uhid = composeUhid(prefix, seq);
      if (APPLY) await prisma.contact.update({ where: { id: c.id }, data: { uhid } });
      numbered += 1;
    }
    if (contacts.length > 0) {
      console.log(`  ${org.name}: numbered ${contacts.length} patient(s) → ${prefix}-…, seq now ${seq}`);
      if (APPLY) {
        await prisma.organization.update({
          where: { id: org.id },
          data: { uhidSeq: seq, ...(org.uhidPrefix ? {} : { uhidPrefix: prefix }) },
        });
      }
    }

    // ── Pass 2: link existing appointments to their patient ───────────────
    // Matched on phone, which is exactly how the app read these two tables
    // together before the relation existed.
    const orphans = await prisma.appointment.findMany({
      where: { orgId: org.id, contactId: null, customerNumber: { not: null } },
      select: { id: true, customerNumber: true },
    });
    if (orphans.length === 0) continue;

    // ⚠ HOUSEHOLD PRIMARIES ONLY (`dependentKey: ''`).
    //
    // A phone number can now belong to several patients. Without this filter the
    // map below is last-write-wins and would link a legacy appointment to an
    // arbitrary family member — quietly filing a grandmother's appointment
    // under her grandson. The primary is the only defensible guess: a dependent
    // can only have been created deliberately, AFTER households shipped, so it
    // cannot be the subject of an unlinked legacy row.
    const byPhone = new Map(
      (
        await prisma.contact.findMany({
          where: { orgId: org.id, dependentKey: '' },
          select: { id: true, phone: true, uhid: true },
        })
      ).map((c) => [c.phone, c]),
    );

    for (const a of orphans) {
      const contact = a.customerNumber ? byPhone.get(a.customerNumber) : undefined;
      if (!contact) continue;
      if (APPLY) {
        await prisma.appointment.update({
          where: { id: a.id },
          data: { contactId: contact.id, patientNo: contact.uhid },
        });
      }
      linked += 1;
    }
    console.log(`  ${org.name}: linked ${linked} appointment(s) to a patient`);
  }

  console.log(`\n${APPLY ? 'Done' : 'Would'}: ${numbered} patient number(s), ${linked} appointment link(s).`);
  if (!APPLY) console.log('Nothing was written. Re-run with --apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
