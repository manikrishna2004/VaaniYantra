/**
 * Delete an organisation and everything belonging to it. IRREVERSIBLE.
 *
 *   npx tsx scripts/delete-org.ts <orgId>                          # dry run
 *   npx tsx scripts/delete-org.ts <orgId> --apply --confirm="Name" # delete
 *
 * This is the operator path behind the deletion promise in /dpa §8 and
 * /data-deletion ("within 30 days, by our team"). There is deliberately no
 * customer-facing button: a tenant cannot destroy their own data by accident,
 * and the most destructive operation in the system needs VM access to reach.
 *
 * Dry run by default, like the backfill scripts. `--apply` additionally demands
 * `--confirm` matching the organisation's exact name, so a mistyped id cannot
 * delete a real customer — you have to know, and type, whose data it is.
 *
 * Why the summary is printed rather than audited: AuditLog cascades away with
 * the organisation, so a row written there would be deleted by the very
 * operation it records. stdout lands in the operator's log and Cloud Logging,
 * which outlive the tenant. Keep the output.
 */
import { countOrgData, deleteOrganization, type OrgDeletionCounts } from '@/lib/org-delete';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, '') : undefined;
}

function table(counts: OrgDeletionCounts): string {
  const rows: [string, number][] = [
    ['calls', counts.calls],
    ['transcript turns', counts.transcriptTurns],
    ['appointments', counts.appointments],
    ['outcomes', counts.outcomes],
    ['whatsapp turns', counts.whatsappTurns],
    ['portal one-time codes', counts.portalOtps],
    ['patients', counts.contacts],
    ['visit records', counts.visitRecords],
    ['workspaces', counts.workspaces],
    ['audit log rows', counts.auditLogs],
  ];
  return rows.map(([k, v]) => `    ${k.padEnd(24)} ${String(v).padStart(8)}`).join('\n');
}

/**
 * Which database this run is pointed at, host and name only — never the
 * password. This script is meant to run on the VM, but it reads DATABASE_URL
 * like everything else, so a copy of prod credentials in a local .env would
 * quietly aim it at live customer data. Printing the target makes the operator
 * see where they are before they type --apply.
 */
function targetDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return '(DATABASE_URL not set)';
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  const orgId = process.argv[2];
  if (!orgId || orgId.startsWith('--')) {
    console.error('Usage: npx tsx scripts/delete-org.ts <orgId> [--apply --confirm="Org Name"]');
    process.exit(1);
  }

  const apply = process.argv.includes('--apply');
  const confirm = arg('confirm');

  const report = await countOrgData(orgId);
  if (!report) {
    console.error(`[delete-org] no organisation with id ${orgId}`);
    process.exit(1);
  }

  console.log(`\n[delete-org] ${report.orgName}  (${report.orgId})`);
  console.log(`[delete-org] database: ${targetDatabase()}\n`);
  console.log('  This would permanently delete:\n');
  console.log(table(report.counts));
  console.log(
    '\n  Plus everything reached by cascade: agents, phone numbers, knowledge\n' +
      '  documents, portals, members, API keys, invoices and integrations.\n',
  );

  if (!apply) {
    console.log('  DRY RUN — nothing was changed.');
    console.log(`  To delete: npx tsx scripts/delete-org.ts ${orgId} --apply --confirm="${report.orgName}"\n`);
    return;
  }

  if (confirm !== report.orgName) {
    console.error(
      `  REFUSED. --confirm must be the organisation's exact name.\n` +
        `  Expected: "${report.orgName}"\n` +
        `  Got:      ${confirm === undefined ? '(missing)' : `"${confirm}"`}\n`,
    );
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const done = await deleteOrganization(orgId);
  // Structured, greppable, and the only surviving record of the deletion.
  console.log(
    `\n[delete-org] DELETED ${JSON.stringify({
      orgId: report.orgId,
      orgName: report.orgName,
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: done?.counts,
    })}\n`,
  );
}

main()
  .catch((e) => {
    console.error('[delete-org] failed — nothing was deleted (the whole run is one transaction)');
    console.error(e);
    process.exit(1);
  })
  .then(() => process.exit(0));
