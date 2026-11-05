import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { usageDrift } from '@/lib/usage/minutes';
import { monthKey, nextMonthKey } from '@/lib/usage/period';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Move one organisation between the two ways of counting a billable minute.
//
//   calls  — SUM(Call.durationSec). What every org has always been billed on.
//   ledger — SUM(UsageEvent.quantity). The only thing that can measure a call
//            we did not run: one placed on a reseller's platform, or answered
//            by a deployment in a client's own cloud.
//
// Founder-only, session-authenticated. Deliberately NOT reachable by a cron
// secret: this changes what a customer is charged from, and nothing about it
// should be automatable.
//
//   GET  /api/admin/usage-source            → every org, with its drift
//   POST /api/admin/usage-source            → { orgId, source, effectiveMonth? }

async function requireFounder() {
  const { ctx, error } = await apiContext();
  if (error) return { ok: false as const, error };
  if (!isSuperAdmin(ctx.user.email)) {
    return { ok: false as const, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true as const, ctx };
}

export async function GET() {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await requireFounder();
  if (!auth.ok) return auth.error;

  const now = new Date();
  const lastClosed = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const [orgs, drift] = await Promise.all([
    prisma.organization.findMany({
      select: { id: true, name: true, plan: true, usageSource: true, usageSourceSince: true },
      orderBy: { name: 'asc' },
    }),
    usageDrift(lastClosed),
  ]);

  const byOrg = new Map(drift.map((d) => [d.orgId, d]));
  return NextResponse.json({
    currentMonth: monthKey(now),
    // Flipping takes effect from the month AFTER the current one — never
    // mid-month, so this is the earliest date a flip can be scheduled for.
    earliestEffectiveMonth: nextMonthKey(monthKey(now)),
    driftMonth: lastClosed,
    orgs: orgs.map((o) => ({
      ...o,
      drift: byOrg.get(o.id) ?? null,
      // Advisory only, and deliberately not enforced below: the real bar is two
      // consecutive clean CLOSED months, which this endpoint cannot see on its
      // own. It is here so the founder is not flipping blind.
      cleanLastClosedMonth: (byOrg.get(o.id)?.deltaMinutes ?? 0) === 0,
    })),
  });
}

export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await requireFounder();
  if (!auth.ok) return auth.error;

  const body = (await req.json().catch(() => ({}))) as {
    orgId?: string;
    source?: string;
    effectiveMonth?: string;
  };

  const orgId = body.orgId?.trim();
  const source = body.source?.trim();
  if (!orgId) return NextResponse.json({ error: 'orgId is required' }, { status: 400 });
  if (source !== 'calls' && source !== 'ledger') {
    return NextResponse.json({ error: 'source must be "calls" or "ledger"' }, { status: 400 });
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, usageSource: true, usageSourceSince: true },
  });
  if (!org) return NextResponse.json({ error: 'No such organization' }, { status: 404 });

  const current = monthKey(new Date());
  const earliest = nextMonthKey(current);
  const effectiveMonth = body.effectiveMonth?.trim() || earliest;

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)) {
    return NextResponse.json({ error: 'effectiveMonth must be YYYY-MM' }, { status: 400 });
  }

  // ── The rule this endpoint exists to enforce ──────────────────────────────
  //
  // A flip may only ever take effect from a FUTURE month. Half a month counted
  // one way and half the other either double-counts the overlap or loses it,
  // and OverageCharge is unique per (org, month) — so the resulting figure is
  // billed once and can never be corrected in place, only apologised for.
  //
  // Enforced here rather than documented in a comment, because "just this once,
  // from today" is exactly the request that will be made under pressure.
  if (effectiveMonth <= current) {
    return NextResponse.json(
      {
        error: `A usage-source change cannot take effect mid-month. The earliest is ${earliest}.`,
        earliestEffectiveMonth: earliest,
      },
      { status: 400 },
    );
  }

  const updated = await prisma.organization.update({
    where: { id: orgId },
    data: {
      usageSource: source,
      // Cleared when moving back to calls: the column means "the month the
      // ledger took over", and leaving a stale date behind would make a future
      // re-flip silently apply from the OLD date.
      usageSourceSince: source === 'ledger' ? effectiveMonth : null,
    },
    select: { id: true, name: true, usageSource: true, usageSourceSince: true },
  });

  await audit(auth.ctx, 'platform.usage_source_changed', {
    targetType: 'Organization',
    targetId: orgId,
    metadata: {
      from: org.usageSource,
      to: source,
      fromSince: org.usageSourceSince,
      effectiveMonth: source === 'ledger' ? effectiveMonth : null,
    },
    req,
  });
  console.log(
    `[usage-source] ${org.name} (${orgId}): ${org.usageSource} → ${source}` +
      (source === 'ledger' ? ` from ${effectiveMonth}` : ''),
  );

  return NextResponse.json({ org: updated });
}
