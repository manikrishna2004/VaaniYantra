import Link from 'next/link';
import { prisma } from '@/lib/db';
import { redirect } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission, homePathFor } from '@/lib/auth/permissions';
import { DashboardView } from '@/components/DashboardView';
import { getEffectivePlan, getUsage, overageFor } from '@/lib/billing/catalogue';

export const dynamic = 'force-dynamic';

async function getData() {
  const ctx = await requireWorkspace();
  // Clinic-wide numbers are ADMIN and OWNER only. A redirect rather than a 404
  // because this is still the default landing after sign-in — a doctor or a
  // front-desk seat should arrive somewhere they can work, not at an error.
  if (!hasPermission(ctx.role, 'insights:read')) redirect(homePathFor(ctx.role));
  const { workspace, org } = ctx;
  const where = { workspaceId: workspace.id };

  // Current-month overage (₹) so the owner isn't surprised by the sweep.
  const orgRow = await prisma.organization.findUnique({ where: { id: org.id }, select: { plan: true } });
  const plan = await getEffectivePlan(orgRow?.plan);
  const usage = await getUsage(org.id);
  const overage = overageFor(plan, usage.callMinutes);

  const days = 14;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowStart = new Date(today);
  windowStart.setDate(today.getDate() - (days - 1));

  // Aggregate at the DB level instead of loading every call into memory.
  const [
    totals,
    completedAgg,
    byDirection,
    bySentiment,
    recent,
    agentCount,
    numberCount,
    documentCount,
    windowCalls,
  ] = await Promise.all([
    prisma.call.aggregate({ where, _count: true, _sum: { durationSec: true } }),
    prisma.call.aggregate({
      where: { ...where, status: 'COMPLETED' },
      _count: true,
      _sum: { durationSec: true },
    }),
    prisma.call.groupBy({ by: ['direction'], where, _count: true }),
    prisma.call.groupBy({ by: ['sentiment'], where, _count: true }),
    prisma.call.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { agent: { select: { name: true } } },
    }),
    prisma.agent.count({ where }),
    prisma.phoneNumber.count({ where }),
    prisma.document.count({ where }),
    prisma.call.findMany({
      where: { ...where, createdAt: { gte: windowStart } },
      select: { createdAt: true },
    }),
  ]);

  const totalCalls = totals._count;
  const completedCount = completedAgg._count;
  const directionCount = (dir: string) =>
    byDirection.find((d) => d.direction === dir)?._count ?? 0;
  const sentimentCount = (val: string) =>
    bySentiment.find((s) => s.sentiment === val)?._count ?? 0;

  const daily: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    daily.push({
      date: d.toISOString().slice(0, 10),
      count: windowCalls.filter((c) => c.createdAt >= d && c.createdAt < next).length,
    });
  }

  return {
    totalCalls,
    inbound: directionCount('INBOUND'),
    outbound: directionCount('OUTBOUND'),
    sentiment: {
      positive: sentimentCount('POSITIVE'),
      neutral: sentimentCount('NEUTRAL'),
      negative: sentimentCount('NEGATIVE'),
    },
    totalDuration: totals._sum.durationSec ?? 0,
    avgDuration: completedCount
      ? Math.round((completedAgg._sum.durationSec ?? 0) / completedCount)
      : 0,
    completionRate: totalCalls ? Math.round((completedCount / totalCalls) * 100) : 0,
    agentCount,
    numberCount,
    documentCount,
    daily,
    recent,
    overage: { minutes: overage.minutes, amountInr: overage.amountInr, ratePerMinute: plan.overagePerMinute ?? null },
  };
}

export default async function DashboardPage() {
  // Resolved again here rather than threaded out of getData(): requireWorkspace
  // reads an already-resolved session, so this costs nothing and keeps the data
  // function about data.
  const ctx = await requireWorkspace();
  const d = await getData();
  // The overage warning used to render here, above the view. It now travels in
  // the data and is rendered alongside the other alerts, so everything wanting
  // attention appears in one place rather than one banner floating above a
  // dashboard that separately reported problems of its own.
  // The sales prompt that used to sit above this is gone. A paying customer's
  // dashboard is not the place to ask them to book a demo, and prospects now
  // have the public /contact page instead.
  return <DashboardView data={d} canBill={hasPermission(ctx.role, 'billing:manage')} />;
}
