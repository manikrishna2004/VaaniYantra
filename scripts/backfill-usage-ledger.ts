/**
 * Backfill the usage ledger from the calls that were billed before it existed.
 *
 *   npx tsx scripts/backfill-usage-ledger.ts                 # dry run
 *   npx tsx scripts/backfill-usage-ledger.ts --apply         # write
 *   npx tsx scripts/backfill-usage-ledger.ts --apply --from=2026-01
 *
 * ── Why this has to happen before anything is flipped ───────────────────────
 *
 * The ledger only starts collecting on the deploy that shipped the dual write.
 * An org flipped to it without a backfill would report zero minutes for every
 * month before that — and the drift report, which is the gate on flipping,
 * compares the two sources month by month. Without this it can never be clean.
 *
 * ── Safe to re-run ──────────────────────────────────────────────────────────
 *
 * Every row is keyed (source='vaani_voice', externalId=Call.id, seq=0), so a
 * second run loses to the unique constraint and changes nothing. An interrupted
 * run just needs running again. It also means this can be run BEFORE the dual
 * write is deployed, or after, or both.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It does not touch Call rows, does not move any org onto the ledger, and does
 * not correct a call whose duration later changed — `recordUsage` writes seq 0
 * or nothing at all. Reconciling a revised duration is syncCallUsage's job on
 * the live path, and a historical call's duration does not change.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const FROM = (process.argv.find((a) => a.startsWith('--from=')) ?? '').split('=')[1] || null;
const BATCH = 500;

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  console.log(APPLY ? '▶ applying' : '▶ dry run (pass --apply to write)');
  if (FROM) console.log(`  only calls from ${FROM} onward`);

  const where = {
    // A call that never reached a workspace has no organisation to bill.
    workspaceId: { not: null },
    ...(FROM ? { createdAt: { gte: new Date(`${FROM}-01T00:00:00Z`) } } : {}),
  };

  const total = await prisma.call.count({ where });
  console.log(`  ${total.toLocaleString('en-IN')} call(s) in scope\n`);

  let cursor: string | undefined;
  let seen = 0;
  let written = 0;
  let skipped = 0;
  const byMonth = new Map<string, number>();

  for (;;) {
    const calls = await prisma.call.findMany({
      where,
      select: {
        id: true,
        workspaceId: true,
        durationSec: true,
        createdAt: true,
        startedAt: true,
        workspace: { select: { orgId: true } },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (calls.length === 0) break;
    cursor = calls[calls.length - 1].id;

    for (const call of calls) {
      seen += 1;
      const orgId = call.workspace?.orgId;
      if (!orgId) {
        skipped += 1;
        continue;
      }
      // The call's own clock, matching syncCallUsage — so a backfilled row and
      // a live one for the same call would land in the same month.
      const occurredAt = call.startedAt ?? call.createdAt;
      const month = monthKey(occurredAt);
      byMonth.set(month, (byMonth.get(month) ?? 0) + call.durationSec);

      if (!APPLY) continue;

      try {
        await prisma.usageEvent.create({
          data: {
            orgId,
            workspaceId: call.workspaceId,
            metric: 'voice.minutes',
            source: 'vaani_voice',
            externalId: call.id,
            seq: 0,
            quantity: call.durationSec,
            occurredAt,
            // Historical rows are stamped with the month they HAPPENED in, not
            // rolled forward past a closed month. They are reconstructing what
            // was already billed from Call.durationSec, so putting them
            // anywhere else would make the drift report disagree with itself.
            billingMonth: month,
            originMonth: month,
            callId: call.id,
            raw: { backfilled: true },
          },
        });
        written += 1;
      } catch (err) {
        // Already recorded — the outcome we wanted.
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    process.stdout.write(`\r  processed ${seen.toLocaleString('en-IN')}/${total.toLocaleString('en-IN')}`);
  }
  process.stdout.write('\n\n');

  console.log('  Minutes per month, from Call.durationSec:');
  for (const month of [...byMonth.keys()].sort()) {
    console.log(`    ${month}  ${Math.round(byMonth.get(month)! / 60).toLocaleString('en-IN').padStart(9)} min`);
  }

  console.log(
    APPLY
      ? `\n✔ wrote ${written.toLocaleString('en-IN')} ledger row(s); ${skipped.toLocaleString('en-IN')} already present or unbillable`
      : `\nDry run — nothing written. Re-run with --apply.`,
  );
  if (APPLY) {
    console.log('  Next: npx tsx scripts/usage-drift.ts --month=<YYYY-MM> — it must report a zero delta everywhere.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
