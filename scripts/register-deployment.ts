/**
 * Register a place this software runs, and issue it a signing key.
 *
 *   npx tsx scripts/register-deployment.ts --list
 *   npx tsx scripts/register-deployment.ts --id=dep_vaani_cloud \
 *       --label="Shared cloud" --mode=shared --issue-key --apply
 *   npx tsx scripts/register-deployment.ts --id=dep_acme --label="Acme" \
 *       --mode=dedicated --org=<orgId> --issue-key --apply
 *   npx tsx scripts/register-deployment.ts --id=dep_acme --rotate --apply
 *   npx tsx scripts/register-deployment.ts --id=dep_acme --revoke=<keyId> --apply
 *   npx tsx scripts/register-deployment.ts --id=dep_acme --suspend --apply
 *
 * ── Register the shared cloud first ─────────────────────────────────────────
 *
 * Before any client has one, our own VM gets `dep_vaani_cloud` and heartbeats
 * to itself (scripts/deployment-heartbeat.sh). That is deliberate: it proves
 * the signing, the replay check and the entitlement path against a real
 * deployment while there is still nobody to break, and it means the first
 * client install is exercising a channel that has been running for weeks.
 *
 * ── The key is printed ONCE ─────────────────────────────────────────────────
 *
 * It is encrypted at rest rather than hashed, because an HMAC has to be
 * recomputed on our side — but nothing reads it back out to a human. Copy it
 * into the deployment's .env as DEPLOYMENT_KEY when it is printed, or issue
 * another one.
 *
 * ── Rotation ────────────────────────────────────────────────────────────────
 *
 * `--rotate` issues a SECOND key without touching the first: both verify, so
 * the install can be updated at leisure and the old key revoked afterwards.
 * Revoking before the box is updated is what turns a rotation into an outage.
 */
import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { issueDeploymentKey } from '../src/lib/deploy/deploy-auth';

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const apply = flag('apply');

async function list() {
  const rows = await prisma.deployment.findMany({
    orderBy: { createdAt: 'asc' },
    include: { keys: { orderBy: { createdAt: 'asc' } } },
  });
  if (rows.length === 0) {
    console.log('  no deployments registered.');
    return;
  }
  for (const d of rows) {
    const seen = d.lastSeenAt ? d.lastSeenAt.toISOString().replace('T', ' ').slice(0, 19) : 'never';
    console.log(
      `  ${d.id}  ${d.mode}  ${d.status}  org=${d.orgId ?? '—'}  v=${d.version ?? '—'}  last seen ${seen}`,
    );
    if (d.lastError) console.log(`      last error: ${d.lastError}`);
    for (const k of d.keys) {
      console.log(
        `      key ${k.id}  ${k.label}  ${k.revokedAt ? `REVOKED ${k.revokedAt.toISOString().slice(0, 10)}` : 'live'}` +
          `  last used ${k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 19).replace('T', ' ') : 'never'}`,
      );
    }
  }
}

async function main() {
  if (flag('list') || process.argv.length <= 2) {
    console.log('▶ deployments\n');
    await list();
    return;
  }

  const id = arg('id');
  if (!id) {
    console.error('✖ --id=dep_<name> is required');
    process.exit(2);
  }
  if (!/^dep_[a-z0-9_]{2,40}$/.test(id)) {
    console.error(`✖ --id must look like dep_acme (lowercase, digits, underscore), got "${id}"`);
    process.exit(2);
  }

  const existing = await prisma.deployment.findUnique({ where: { id } });
  const mode = arg('mode') ?? existing?.mode ?? 'dedicated';
  if (mode !== 'shared' && mode !== 'dedicated') {
    console.error(`✖ --mode must be shared or dedicated, got "${mode}"`);
    process.exit(2);
  }
  const orgId = arg('org') ?? existing?.orgId ?? null;
  if (mode === 'dedicated' && !orgId) {
    // A dedicated install with no org has nothing to be single-tenant ABOUT,
    // and its telemetry would have nowhere to land.
    console.error('✖ a dedicated deployment needs --org=<orgId>');
    process.exit(2);
  }
  if (orgId) {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    if (!org) {
      console.error(`✖ no organisation ${orgId}`);
      process.exit(2);
    }
    console.log(`  org: ${org.name} (${orgId})`);
  }

  const label = arg('label') ?? existing?.label ?? id;
  const revoke = arg('revoke');

  console.log(`▶ ${existing ? 'updating' : 'registering'} ${id} — ${label}, mode=${mode}`);
  if (flag('issue-key') || flag('rotate')) console.log('  would issue a signing key');
  if (revoke) console.log(`  would revoke key ${revoke}`);
  if (flag('suspend')) console.log('  would SUSPEND it (entitlement refused from the next fetch)');
  if (flag('resume')) console.log('  would return it to ACTIVE');

  if (!apply) {
    console.log('\n  dry run — nothing written. Re-run with --apply.');
    return;
  }

  const status = flag('suspend') ? 'SUSPENDED' : flag('resume') ? 'ACTIVE' : existing?.status ?? 'ACTIVE';
  await prisma.deployment.upsert({
    where: { id },
    create: {
      id,
      label,
      mode,
      orgId,
      status,
      notes: arg('note'),
      // Suspending is not the same as revoking entitlement, but suspending
      // without it would leave a live token good for up to an hour.
      entitlementRevokedAt: flag('suspend') ? new Date() : null,
    },
    update: {
      label,
      mode,
      orgId,
      status,
      ...(arg('note') ? { notes: arg('note') } : {}),
      ...(flag('suspend') ? { entitlementRevokedAt: new Date() } : {}),
      ...(flag('resume') ? { entitlementRevokedAt: null } : {}),
    },
  });

  if (revoke) {
    await prisma.deploymentKey.update({ where: { id: revoke }, data: { revokedAt: new Date() } });
    console.log(`  revoked key ${revoke}`);
  }

  if (flag('issue-key') || flag('rotate')) {
    const key = await issueDeploymentKey({
      deploymentId: id,
      label: flag('rotate') ? `rotated ${new Date().toISOString().slice(0, 10)}` : 'initial',
    });
    console.log(`\n  key ${key.id} — put this in the deployment's .env, it is not shown again:\n`);
    console.log(`    DEPLOYMENT_ID="${id}"`);
    console.log(`    DEPLOYMENT_KEY="${key.secret}"`);
    if (mode === 'dedicated') {
      console.log(`    DEPLOYMENT_MODE="dedicated"`);
      console.log(`    DEPLOYMENT_ORG_ID="${orgId}"`);
      console.log(`    CONTROL_PLANE_URL="https://vaaniyantra.com"`);
    }
    console.log('');
  }

  console.log('✔ done.\n');
  await list();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
