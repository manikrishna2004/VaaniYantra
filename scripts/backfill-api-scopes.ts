/**
 * Grant every pre-scope API key the wildcard, so scope enforcement can be
 * switched on without breaking a live integration.
 *
 *   npx tsx scripts/backfill-api-scopes.ts          # dry run — prints what it would do
 *   npx tsx scripts/backfill-api-scopes.ts --apply  # write
 *
 * ── Why the wildcard and not a guess ────────────────────────────────────────
 *
 * ApiKey.scopes has never been enforced, so every existing key can currently
 * call every v1 endpoint. Narrowing a key here would silently break whatever
 * the customer built against it, and we cannot know from the schema which
 * endpoints they actually call. lastUsedAt tells us a key is live, not what it
 * touches. So the backfill preserves today's behaviour exactly — ['*'] — and
 * narrowing is a conversation with each customer, not a migration.
 *
 * ── The order this belongs in ───────────────────────────────────────────────
 *
 *   1. Deploy scope enforcement. Empty scopes still allow, and log a warning.
 *   2. Run this with --apply. Every live key now carries an explicit grant.
 *   3. Watch for `[api-keys] key … has no scopes` in the pm2 logs. Any hit is a
 *      key created between 1 and 2, or a database this never ran against.
 *   4. When a week passes with no warning, set API_SCOPES_STRICT=true.
 *
 * Safe to re-run: keys that already carry a grant are skipped, so an
 * interrupted run just needs running again.
 */
import { PrismaClient } from '@prisma/client';
import { WILDCARD } from '../src/lib/api/scopes';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '▶ applying' : '▶ dry run (pass --apply to write)');

  // Revoked and expired keys are included deliberately. They authenticate
  // nothing, but leaving them as the only rows with an empty scope list would
  // make the "are we clear to go strict?" check ambiguous forever.
  const keys = await prisma.apiKey.findMany({
    where: { scopes: { isEmpty: true } },
    select: {
      id: true,
      name: true,
      orgId: true,
      lastFour: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
      org: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (keys.length === 0) {
    console.log('✔ no keys without scopes — nothing to do');
    return;
  }

  const now = new Date();
  let live = 0;
  for (const k of keys) {
    const dead = Boolean(k.revokedAt) || (k.expiresAt !== null && k.expiresAt < now);
    if (!dead) live += 1;
    const used = k.lastUsedAt ? `last used ${k.lastUsedAt.toISOString().slice(0, 10)}` : 'never used';
    console.log(
      `  ${dead ? '·' : '→'} ${k.org.name} / ${k.name} (…${k.lastFour}) — ${used}${dead ? ', revoked/expired' : ''}`,
    );
  }
  console.log(`\n${keys.length} key(s) without scopes, ${live} still live.`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  const { count } = await prisma.apiKey.updateMany({
    where: { id: { in: keys.map((k) => k.id) } },
    data: { scopes: [WILDCARD] },
  });

  // One audit row per org rather than per key: this is a platform action, not
  // something a member of that org did, and AuditLog is what the org's own
  // audit viewer reads. Recording it there is how a customer can see that
  // their keys were touched and when.
  const byOrg = new Map<string, number>();
  for (const k of keys) byOrg.set(k.orgId, (byOrg.get(k.orgId) ?? 0) + 1);
  for (const [orgId, n] of byOrg) {
    await prisma.auditLog.create({
      data: {
        orgId,
        action: 'platform.apikey_scope_backfill',
        targetType: 'ApiKey',
        metadata: { keys: n, scopes: [WILDCARD] },
      },
    });
  }

  console.log(`✔ granted ["${WILDCARD}"] to ${count} key(s) across ${byOrg.size} org(s)`);
  console.log('  Now watch pm2 logs for "[api-keys] key … has no scopes" before setting API_SCOPES_STRICT=true.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
