/**
 * One-off backfill: mark every PRE-EXISTING visit's diagnosis as already
 * released to the patient.
 *
 *   npx tsx scripts/backfill-diagnosis-release.ts          # dry run
 *   npx tsx scripts/backfill-diagnosis-release.ts --apply  # write
 *
 * WHY THIS EXISTS
 * `diagnosisSharedAt = null` now means "held". Without this, deploying the
 * reading code silently retracts every diagnosis a patient could already read —
 * mid-treatment, with no explanation. That is worse than the problem the hold
 * was built to solve.
 *
 * RUN IT BETWEEN THE SCHEMA PUSH AND THE CODE DEPLOY. Backfilling afterwards
 * leaves a window in which diagnoses disappear from patients' phones.
 *
 * THE CUTOFF IS THE IMPORTANT PART. It is a hardcoded timestamp, not `now()`,
 * so a well-meaning re-run in six months cannot auto-release a diagnosis a
 * doctor deliberately held. Set it to roughly when you push the schema.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Everything created before this is pre-hold and gets released. */
const CUTOFF = new Date('2026-08-01T00:00:00.000Z');

async function main() {
  console.log(APPLY ? '▶ applying' : '▶ dry run (pass --apply to write)');
  console.log(`  cutoff: ${CUTOFF.toISOString()} — only visits created before this are touched`);

  if (CUTOFF.getTime() > Date.now()) {
    console.warn('  ⚠ the cutoff is in the future, so this will release visits created from now on too.');
  }

  const where = {
    diagnosisSharedAt: null,
    diagnosis: { not: null },
    createdAt: { lt: CUTOFF },
  } as const;

  const count = await prisma.visitRecord.count({ where });
  console.log(`  ${count} visit(s) with a diagnosis and no release date`);

  if (!APPLY) {
    console.log('\nNothing was written. Re-run with --apply.');
    return;
  }

  // Released as of when the record was created, not now — the patient could
  // already see it, so that is the honest timestamp.
  const rows = await prisma.visitRecord.findMany({ where, select: { id: true, createdAt: true } });
  let done = 0;
  for (const row of rows) {
    await prisma.visitRecord.update({
      where: { id: row.id },
      data: { diagnosisSharedAt: row.createdAt },
    });
    done += 1;
  }
  console.log(`\nDone: released ${done} diagnosis/diagnoses.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
