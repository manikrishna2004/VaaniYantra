import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

// Dashboard analytics: totals, by-direction, by-status, recent daily volume.
export async function GET() {
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'insights:read')) {
    return NextResponse.json({ error: 'You do not have access to analytics.' }, { status: 403 });
  }


  const [calls, agentCount, numberCount, documentCount] = await Promise.all([
    prisma.call.findMany({
      where: { workspaceId: workspace.id },
      select: { direction: true, status: true, durationSec: true, createdAt: true, sentiment: true },
    }),
    prisma.agent.count({ where: { workspaceId: workspace.id } }),
    prisma.phoneNumber.count({ where: { workspaceId: workspace.id } }),
    prisma.document.count({ where: { workspaceId: workspace.id } }),
  ]);

  const totalCalls = calls.length;
  const completed = calls.filter((c) => c.status === 'COMPLETED');
  const totalDuration = calls.reduce((s, c) => s + (c.durationSec || 0), 0);
  const avgDuration = completed.length
    ? Math.round(completed.reduce((s, c) => s + c.durationSec, 0) / completed.length)
    : 0;

  const inbound = calls.filter((c) => c.direction === 'INBOUND').length;
  const outbound = calls.filter((c) => c.direction === 'OUTBOUND').length;
  const completionRate = totalCalls ? Math.round((completed.length / totalCalls) * 100) : 0;

  const sentiment = {
    positive: calls.filter((c) => c.sentiment === 'POSITIVE').length,
    neutral: calls.filter((c) => c.sentiment === 'NEUTRAL').length,
    negative: calls.filter((c) => c.sentiment === 'NEGATIVE').length,
  };

  // Daily volume for the last 14 days.
  const days = 14;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daily: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    const count = calls.filter(
      (c) => c.createdAt >= d && c.createdAt < next,
    ).length;
    daily.push({ date: d.toISOString().slice(0, 10), count });
  }

  return NextResponse.json({
    totalCalls,
    totalDurationSec: totalDuration,
    avgDurationSec: avgDuration,
    inbound,
    outbound,
    completionRate,
    sentiment,
    agentCount,
    numberCount,
    documentCount,
    daily,
  });
}
