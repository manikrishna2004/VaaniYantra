/**
 * Agree a rate card for one client.
 *
 *   npx tsx scripts/set-rate-card.ts --org=<id|slug> --price=4.2            # dry run
 *   npx tsx scripts/set-rate-card.ts --org=acme --price=4.2 --cost=2.8 \
 *       --retainer=25000 --from=2026-10-01 --note="Oct deal, 3 automations" --apply
 *   npx tsx scripts/set-rate-card.ts --org=acme --show                      # history
 *
 * ⚠ THIS IS THE ONE-WAY DOOR IN PHASE 5. Everything else in the rate-card work
 * is a no-op until a row exists in this table; writing one is the moment a
 * price becomes a price somebody was quoted. It dry-runs by default and prints
 * exactly what it would write, because the cheap mistake here — a rate typed in
 * paise, a date a month out — is not cheap to unwind once a month is closed
 * against it.
 *
 * What it does, in one transaction:
 *   1. closes the card currently in force (sets effectiveTo = --from), and
 *   2. inserts the new one.
 * Nothing is ever edited in place, so "what were they paying in March" stays
 * answerable after April's renegotiation.
 *
 * ── Flags ───────────────────────────────────────────────────────────────────
 *   --org=       organisation id or slug (required)
 *   --price=     ₹ per billable minute (required)
 *   --cost=      ₹ per minute the supplier charges us — margin, never billed
 *   --retainer=  flat ₹/month for the automation work
 *   --minimum=   ₹/month floor on the usage charge (a commitment)
 *   --cap=       monthly minute cap for this client (runaway-usage stop)
 *   --from=      YYYY-MM-DD the card takes effect (default: the 1st of next month)
 *   --note=      why this deal is these numbers
 *   --wallet     also move the org onto billingModel=prepaid_wallet
 *   --show       print the org's card history and exit
 *   --apply      actually write
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const numArg = (name: string): number | null => {
  const raw = arg(name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`✖ --${name} must be a number >= 0, got "${raw}"`);
    process.exit(2);
  }
  return n;
};

/** The 1st of next month, UTC — the only start date that cannot reprice a month already being lived. */
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`;

async function main() {
  const orgArg = arg('org');
  if (!orgArg) {
    console.error('✖ --org=<id|slug> is required');
    process.exit(2);
  }

  const org = await prisma.organization.findFirst({
    where: { OR: [{ id: orgArg }, { slug: orgArg }] },
    select: { id: true, name: true, slug: true, plan: true, billingModel: true },
  });
  if (!org) {
    console.error(`✖ no organisation with id or slug "${orgArg}"`);
    process.exit(2);
  }

  const cards = await prisma.rateCard.findMany({
    where: { orgId: org.id },
    orderBy: { effectiveFrom: 'desc' },
  });

  console.log(`▶ ${org.name} (${org.slug}) — plan ${org.plan}, billingModel ${org.billingModel}\n`);
  if (cards.length === 0) {
    console.log('  no rate cards: this org is priced from the plan catalogue.\n');
  } else {
    for (const c of cards) {
      const until = c.effectiveTo ? c.effectiveTo.toISOString().slice(0, 10) : 'in force';
      console.log(
        `  ${c.effectiveFrom.toISOString().slice(0, 10)} → ${until}  ` +
          `${money(Number(c.pricePerMinute))}/min  cost ${money(c.costPerMinute && Number(c.costPerMinute))}  ` +
          `retainer ${money(c.retainerInr && Number(c.retainerInr))}  min ${money(c.minimumInr && Number(c.minimumInr))}` +
          (c.note ? `\n      ${c.note}` : ''),
      );
    }
    console.log('');
  }

  if (flag('show')) return;

  const price = numArg('price');
  if (price == null) {
    console.error('✖ --price=<₹ per minute> is required (or use --show)');
    process.exit(2);
  }

  const fromRaw = arg('from');
  const effectiveFrom = fromRaw ? new Date(`${fromRaw}T00:00:00.000Z`) : firstOfNextMonth();
  if (Number.isNaN(effectiveFrom.getTime())) {
    console.error(`✖ --from must be YYYY-MM-DD, got "${fromRaw}"`);
    process.exit(2);
  }

  const data = {
    orgId: org.id,
    effectiveFrom,
    currency: 'INR',
    pricePerMinute: price,
    costPerMinute: numArg('cost'),
    retainerInr: numArg('retainer'),
    minimumInr: numArg('minimum'),
    monthlyMinuteCap: numArg('cap'),
    note: arg('note'),
  };

  const standing = cards.find((c) => c.effectiveTo === null);
  console.log(`  would write, effective ${effectiveFrom.toISOString().slice(0, 10)}:`);
  console.log(`    ${money(price)}/min, cost ${money(data.costPerMinute)}, retainer ${money(data.retainerInr)}, minimum ${money(data.minimumInr)}, cap ${data.monthlyMinuteCap ?? '—'}`);
  if (standing) {
    console.log(`  would close the card from ${standing.effectiveFrom.toISOString().slice(0, 10)}`);
  }
  if (flag('wallet') && org.billingModel !== 'prepaid_wallet') {
    console.log('  would move the org onto billingModel=prepaid_wallet');
  }
  if (effectiveFrom < new Date()) {
    console.log(
      '  ⚠ this start date is in the PAST. Any month it covers that has already\n' +
        '    been swept keeps the price it was closed at — OverageCharge is unique\n' +
        '    per (org, month) and is never re-priced.',
    );
  }

  if (!flag('apply')) {
    console.log('\n  dry run — nothing written. Re-run with --apply.');
    return;
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.rateCard.updateMany({
      where: { orgId: org.id, effectiveTo: null, effectiveFrom: { lte: effectiveFrom } },
      data: { effectiveTo: effectiveFrom },
    });
    const row = await tx.rateCard.create({ data, select: { id: true } });
    if (flag('wallet')) {
      await tx.organization.update({
        where: { id: org.id },
        data: { billingModel: 'prepaid_wallet' },
      });
    }
    return row;
  });

  console.log(`\n✔ rate card ${created.id} written for ${org.name}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
