import { prisma } from '@/lib/db';

// Which plan an org was on at a given moment.
//
// `organization.plan` answers "what are they on now", which is the wrong
// question for anything retrospective. The overage sweep runs on the 2nd and
// 5th and bills the previous month; reading the live column meant a customer who
// downgraded to free on the 1st had the whole previous month's overage silently
// written off, and one who upgraded had their old month re-priced at the new
// plan's rate. Both were invisible: the sweep reported success either way.
//
// This is append-only history. Nothing here throws into a caller — recording a
// plan change must never be the reason a payment or an admin action fails, so
// failures are logged and the change still stands.

/** Record that an org moved to `plan`. Safe to call after the write succeeds. */
export async function recordPlanChange(
  orgId: string,
  plan: string,
  source: 'checkout' | 'self_serve' | 'admin' | 'cancel' | 'subscription',
): Promise<void> {
  try {
    await prisma.planChange.create({ data: { orgId, plan, source } });
  } catch (err) {
    console.error('[plan-history] could not record', plan, 'for org', orgId, err);
  }
}

/**
 * The plan an org held at `at` — the last change on or before that moment.
 *
 * Falls back to the org's current plan when there is no history before `at`,
 * which is the honest answer for orgs that predate this table and for the first
 * month after it ships: no history means no evidence they were ever on anything
 * else. That fallback reproduces the old behaviour exactly once, then stops.
 */
export async function planAt(orgId: string, at: Date): Promise<string | null> {
  const prior = await prisma.planChange.findFirst({
    where: { orgId, changedAt: { lte: at } },
    orderBy: { changedAt: 'desc' },
    select: { plan: true },
  });
  if (prior) return prior.plan;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true },
  });
  return org?.plan ?? null;
}

/**
 * Give an org a starting point in the history, if it has none.
 *
 * Called once per org by the sweep. Without it, an org that never changes plan
 * again would keep falling back to the live column forever, and the fallback
 * would silently start lying the day they do change.
 */
export async function seedPlanHistory(orgId: string, plan: string): Promise<void> {
  try {
    const any = await prisma.planChange.findFirst({ where: { orgId }, select: { id: true } });
    if (any) return;
    // Backdated, because this plan was in effect before today — dating it now
    // would make it look like a change that happened during the swept month.
    await prisma.planChange.create({
      data: { orgId, plan, source: 'seed', changedAt: new Date('2020-01-01T00:00:00Z') },
    });
  } catch (err) {
    console.error('[plan-history] could not seed history for org', orgId, err);
  }
}
