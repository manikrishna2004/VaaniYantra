import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// List the workspace's captured outcomes (leads / reservations / orders /
// appointments / …) for the in-app "Updates" feed. Read-only. Optional
// filters: ?agentId=… and ?type=….
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:read');
  if (denied) return denied;

  const url = new URL(req.url);
  const agentId = url.searchParams.get('agentId')?.trim() || undefined;
  const type = url.searchParams.get('type')?.trim() || undefined;

  const outcomes = await prisma.outcome.findMany({
    where: { workspaceId: ctx.workspace.id, ...(agentId ? { agentId } : {}), ...(type ? { type } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      type: true,
      vertical: true,
      fields: true,
      callerName: true,
      callerNumber: true,
      createdAt: true,
      agent: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json(outcomes);
}
