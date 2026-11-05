/**
 * Compare the two ways of counting a billable minute, per org, for one month.
 *
 *   npx tsx scripts/usage-drift.ts                    # last closed month
 *   npx tsx scripts/usage-drift.ts --month=2026-08
 *
 * This is the GATE on Phase 3. While the ledger runs in shadow, the only thing
 * that proves the dual write is complete is that it produces the same number as
 * the calls table it shadows — for every org, for a whole month, twice running.
 *
 * Exits non-zero when any org drifts, so it can be wired into a cron or CI and
 * be believed rather than read.
 *
 * A non-zero delta means one of:
 *   • a call ended down a path that does not sync to the ledger yet;
 *   • the backfill has not been run (or was run with --from= too late);
 *   • a correction rolled forward into this month from an earlier, closed one,
 *     which is correct behaviour and shows up as ledger > calls. Check
 *     originMonth on the rows before treating it as a bug.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ARG = (process.argv.find((a) => a.startsWith('--month=')) ?? '').split('=')[1] || null;

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lastClosedMonth(): string {
  const now = new Date();
  return monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

async function main() {
  const month = ARG ?? lastClosedMonth();
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    console.error(`✖ --month must be YYYY-MM, got "${month}"`);
    process.exit(2);
  }
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));

  console.log(`▶ usage drift for ${month}\n`);

  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, usageSource: true, usageSourceSince: true },
    orderBy: { createdAt: 'asc' },
  });

  let drifted = 0;
  let active = 0;
  const rows: string[] = [];

  for (const org of orgs) {
    const [callAgg, ledgerAgg] = await Promise.all([
      prisma.call.aggregate({
        where: { workspace: { orgId: org.id }, createdAt: { gte: from, lt: to } },
        _sum: { durationSec: true },
      }),
      prisma.usageEvent.aggregate({
        where: { orgId: org.id, billingMonth: month, metric: 'voice.minutes' },
        _sum: { quantity: true },
      }),
    ]);

    const callMinutes = Math.round((callAgg._sum.durationSec ?? 0) / 60);
    const ledgerMinutes = Math.round((ledgerAgg._sum.quantity ?? 0) / 60);
    if (callMinutes === 0 && ledgerMinutes === 0) continue;

    active += 1;
    const delta = ledgerMinutes - callMinutes;
    if (delta !== 0) drifted += 1;

    const mark = delta === 0 ? '✔' : '✖';
    const src = org.usageSource === 'ledger' ? ' [on ledger]' : '';
    rows.push(
      `  ${mark} ${org.name.slice(0, 34).padEnd(36)}` +
        `calls ${String(callMinutes).padStart(8)}  ` +
        `ledger ${String(ledgerMinutes).padStart(8)}  ` +
        `delta ${String(delta > 0 ? `+${delta}` : delta).padStart(7)}${src}`,
    );
  }

  console.log(rows.join('\n') || '  (no org used any minutes this month)');
  console.log(`\n  ${active} active org(s), ${drifted} drifting.`);

  if (drifted > 0) {
    console.log('\n✖ Do NOT move any org onto the ledger while this is non-zero.');
    process.exit(1);
  }
  console.log('\n✔ Both sources agree for every org this month.');
  console.log('  Two consecutive clean CLOSED months are the bar before flipping an org.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
