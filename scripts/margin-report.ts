/**
 * What each client paid, what their minutes cost us, and the difference.
 *
 *   npx tsx scripts/margin-report.ts                  # last closed month
 *   npx tsx scripts/margin-report.ts --month=2026-09
 *   npx tsx scripts/margin-report.ts --json
 *
 * Exits non-zero when any org is at or below cost, so it can be wired into the
 * monthly cron and be believed rather than read. A negative margin is not a
 * reporting curiosity: it means a deal was quoted under what the supplier
 * charges, and every minute spoken on it makes the month worse.
 *
 * Two numbers deserve suspicion when they appear:
 *
 *   • `gap` — our summed per-call supplier cost against the invoice they
 *     actually sent. A gap means the rate we freeze at ingest is wrong, and
 *     every margin below is wrong with it. Enter the invoice first
 *     (SupplierInvoice) or the check has nothing to compare against.
 *   • `projected` — the month has not been swept yet, so revenue is what the
 *     rate says it would be, not what was charged.
 */
import { marginForMonth } from '../src/lib/billing/margin';
import { prisma } from '../src/lib/db';

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function lastClosedMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const rpad = (s: string, n: number) => s.padStart(n);

async function main() {
  const month = arg('month') ?? lastClosedMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    console.error(`✖ --month must be YYYY-MM, got "${month}"`);
    process.exit(2);
  }

  const report = await marginForMonth(month);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`▶ margin for ${month}\n`);
    console.log(
      `  ${pad('org', 28)} ${rpad('mins', 7)} ${rpad('revenue', 12)} ${rpad('supplier', 11)} ${rpad('llm', 10)} ${rpad('margin', 12)} ${rpad('%', 7)}`,
    );
    for (const r of report.orgs) {
      const marker = r.marginInr < 0 ? '✖' : r.projected ? '~' : ' ';
      console.log(
        `${marker} ${pad(r.orgName, 28)} ${rpad(String(r.minutes), 7)} ${rpad(inr(r.revenueInr), 12)} ` +
          `${rpad(inr(r.supplierInr), 11)} ${rpad(inr(r.llmInr), 10)} ${rpad(inr(r.marginInr), 12)} ${rpad(`${r.marginPct}%`, 7)}` +
          (r.rateSource === 'card' ? '  [card]' : ''),
      );
    }
    const t = report.totals;
    console.log(
      `\n  ${pad('TOTAL', 28)} ${rpad(String(t.minutes), 7)} ${rpad(inr(t.revenueInr), 12)} ` +
        `${rpad(inr(t.supplierInr), 11)} ${rpad(inr(t.llmInr), 10)} ${rpad(inr(t.marginInr), 12)} ${rpad(`${t.marginPct}%`, 7)}`,
    );

    const s = report.supplier;
    console.log(
      `\n  ${s.provider}: ledger ${inr(s.ledgerCostInr)}, invoice ${s.invoicedInr === null ? 'not entered' : inr(s.invoicedInr)}` +
        (s.gapInr === null ? '' : `, gap ${inr(s.gapInr)}`),
    );
    if (s.gapInr !== null && Math.abs(s.gapInr) > 1) {
      console.log('  ⚠ the invoice and our own sum disagree — the per-call cost we freeze at ingest is wrong.');
    }
    console.log('\n  ~ = month not swept yet (revenue is projected)   [card] = priced from a client rate card');
  }

  if (report.negative.length > 0) {
    console.error(`\n✖ ${report.negative.length} org(s) at or below cost: ${report.negative.map((r) => r.orgName).join(', ')}`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
