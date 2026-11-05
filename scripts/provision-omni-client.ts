/**
 * Put a NEW client on the reseller platform, correctly, in one command.
 *
 *   npx tsx scripts/provision-omni-client.ts --org=<id|slug> --sub-account=<their id>
 *   npx tsx scripts/provision-omni-client.ts --org=acme --sub-account=41207 \
 *       --price=4.5 --cost=2.9 --label="Acme Interiors" --apply
 *   npx tsx scripts/provision-omni-client.ts --list-sub-accounts
 *
 * This is Phase 6, and it is the ONE-WAY DOOR the phasing warns about: once a
 * client's minutes are spoken on somebody else's infrastructure, there is no
 * Call row to fall back on. What we bill them is what the pull says, and the
 * pull is the only record that exists.
 *
 * So the four things that have to be true together are done together, or not at
 * all — a client half-provisioned is a client billed wrongly:
 *
 *   1. a VoicePlatformAccount linking the org to their sub-account,
 *   2. usageSource='ledger' from the first month (safe only because the org is
 *      NEW — there is no earlier month metered the other way),
 *   3. a RateCard, so the minutes have a price that is not the catalogue's,
 *   4. billingModel='prepaid_wallet', so the credit gate applies whatever plan
 *      key the org holds.
 *
 * ── Only for an org with no history ─────────────────────────────────────────
 *
 * The script refuses an org that already has calls or a closed month. Flipping
 * one of those onto the ledger mid-life is the admin route's job
 * (/api/admin/usage-source), which only allows it from a FUTURE month, after
 * two clean drift months — because half a month counted each way is billed once
 * into a row that is unique per (org, month) and cannot be corrected in place.
 *
 * ── Before the first real client ────────────────────────────────────────────
 *
 * Verify a full month of their pull against their own dashboard first, and
 * check SUM(UsageEvent.costInr) against their invoice (scripts/margin-report.ts).
 * The reconciler is installed and authenticating, but until the reseller key is
 * set in /admin it reports `accounts: 0` and there is nothing to verify.
 */
import { prisma } from '@/lib/db';
import { getVoicePlatform } from '@/lib/adapters/voice-platform';
import { setRateCard } from '@/lib/billing/rate-card';
import { monthKey } from '@/lib/usage/period';

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, '') : null;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function listSubAccounts() {
  const provider = await getVoicePlatform();
  if (!provider) {
    console.error(
      '✖ no voice platform configured. The reseller key is stored encrypted in PlatformConfig\n' +
        '  (omnidimension_api_key) and set from /admin — deliberately not an env var, because a\n' +
        '  partner key that can move credits between client accounts does not belong in a file on the VM.',
    );
    process.exit(2);
  }
  const accounts = await provider.listSubAccounts();
  console.log(`▶ ${provider.name} sub-accounts (${accounts.length})\n`);
  for (const a of accounts) {
    console.log(
      `  ${String(a.subAccountId).padEnd(12)} ${a.name.padEnd(30)} cost/min ${a.costPerMin ?? '—'}  balance ${a.balanceMinutes ?? '—'} min  tz ${a.timezone ?? '—'}`,
    );
  }
  if (accounts.length === 0) {
    console.log('  none. An empty list with a configured key means the key is not a reseller key.');
  }
  console.log('');
}

async function main() {
  if (flag('list-sub-accounts')) {
    await listSubAccounts();
    return;
  }

  const orgArg = arg('org');
  const subAccountId = arg('sub-account');
  const price = arg('price') === null ? null : Number(arg('price'));
  const cost = arg('cost') === null ? null : Number(arg('cost'));
  if (!orgArg || !subAccountId) {
    console.error('Usage: --org=<id|slug> --sub-account=<provider id> [--price=4.5] [--cost=2.9] [--label=…] [--apply]');
    process.exit(2);
  }
  if (price === null || !(price > 0)) {
    console.error('✖ --price=<₹ per minute> is required: a reseller client billed from the catalogue rate is a margin accident waiting to happen.');
    process.exit(2);
  }

  const org = await prisma.organization.findFirst({
    where: { OR: [{ id: orgArg }, { slug: orgArg }] },
    select: { id: true, name: true, slug: true, plan: true, usageSource: true, billingModel: true },
  });
  if (!org) {
    console.error(`✖ no organisation with id or slug "${orgArg}"`);
    process.exit(2);
  }

  // ── The refusal that matters ──────────────────────────────────────────────
  const [calls, charges, existingAccount] = await Promise.all([
    prisma.call.count({ where: { workspace: { orgId: org.id } } }),
    prisma.overageCharge.count({ where: { orgId: org.id } }),
    prisma.voicePlatformAccount.findFirst({ where: { orgId: org.id } }),
  ]);
  if (calls > 0 || charges > 0) {
    console.error(
      `✖ ${org.name} already has ${calls} call(s) and ${charges} closed month(s).\n` +
        '  This script is for a NEW org only. Move an existing one with /api/admin/usage-source,\n' +
        '  which allows the flip only from a future month and only after two clean drift months.',
    );
    process.exit(2);
  }
  if (existingAccount) {
    console.error(`✖ ${org.name} is already linked to sub-account ${existingAccount.subAccountId}.`);
    process.exit(2);
  }

  const provider = await getVoicePlatform();
  const remote = provider ? (await provider.listSubAccounts()).find((a) => String(a.subAccountId) === subAccountId) : null;
  if (provider && !remote) {
    console.error(`✖ ${provider.name} has no sub-account ${subAccountId}. Run --list-sub-accounts.`);
    process.exit(2);
  }
  if (!provider) {
    console.log('  ⚠ no reseller key configured, so the sub-account cannot be verified from here.');
  }

  const from = monthKey(new Date());
  const label = arg('label') ?? org.name;

  console.log(`\n▶ ${org.name} (${org.slug}) — plan ${org.plan}\n`);
  console.log(`  link         sub-account ${subAccountId}${remote ? ` — ${remote.name}` : ''}`);
  console.log(`  cost/min     ${remote?.costPerMin ?? cost ?? '—'} (theirs)`);
  console.log(`  balance      ${remote?.balanceMinutes ?? '—'} minutes upstream — the ceiling that actually bites`);
  console.log(`  timezone     ${remote?.timezone ?? '—'} — decides which month an ambiguous timestamp lands in`);
  console.log(`  usageSource  ${org.usageSource} → ledger, from ${from}`);
  console.log(`  billing      ${org.billingModel} → prepaid_wallet`);
  console.log(`  rate card    ₹${price}/min, cost ₹${cost ?? remote?.costPerMin ?? '—'}/min`);

  if (!flag('apply')) {
    console.log('\n  dry run — nothing written. Re-run with --apply.\n');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.voicePlatformAccount.create({
      data: {
        provider: provider?.name ?? 'omnidimension',
        orgId: org.id,
        subAccountId,
        label,
        costPerMin: remote?.costPerMin ?? cost,
        balanceMinutes: remote?.balanceMinutes ?? null,
        timezone: remote?.timezone ?? null,
      },
    });
    await tx.organization.update({
      where: { id: org.id },
      data: {
        usageSource: 'ledger',
        // Safe from this month only because the org has no earlier month: with
        // no calls and no closed months there is nothing that was metered the
        // other way, so nothing is counted twice or lost.
        usageSourceSince: from,
        billingModel: 'prepaid_wallet',
      },
    });
  });

  await setRateCard({
    orgId: org.id,
    // Backdated to the start of this month so the first month is priced by the
    // card rather than half by the catalogue.
    effectiveFrom: new Date(`${from}-01T00:00:00.000Z`),
    pricePerMinute: price,
    costPerMinute: cost ?? remote?.costPerMin ?? null,
    note: arg('note') ?? `Reseller client, sub-account ${subAccountId}`,
  });

  console.log('\n✔ provisioned.\n');
  console.log('  Next, in this order:');
  console.log('   1. bash scripts/omni-reconcile.sh                 # pull their minutes');
  console.log('   2. npx tsx scripts/usage-drift.ts --month=' + from + '   # ledger is now the only source');
  console.log('   3. npx tsx scripts/margin-report.ts --month=' + from);
  console.log('  The monthly sweep will refuse to close this org\'s month until the pull is clean');
  console.log('  (blocked_unreconciled) — that refusal is the safety net, not a warning to override.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
