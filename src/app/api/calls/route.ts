import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { stripInternalCostAll } from '@/lib/calls/redact';

export const dynamic = 'force-dynamic';

// List call history with optional filters: ?agentId=&status=&direction=
export async function GET(req: Request) {
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'call:read')) {
    return NextResponse.json({ error: 'You do not have access to call history.' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId') || undefined;
  const status = searchParams.get('status') || undefined;
  const direction = searchParams.get('direction') || undefined;

  const calls = await prisma.call.findMany({
    where: {
      workspaceId: workspace.id,
      ...(agentId ? { agentId } : {}),
      ...(status ? { status: status as any } : {}),
      ...(direction ? { direction: direction as any } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      agent: { select: { id: true, name: true } },
      _count: { select: { transcript: true } },
    },
  });
  // `include` returns every scalar on the model, and that now includes what the
  // call cost us to run. See lib/calls/redact.
  return NextResponse.json(stripInternalCostAll(calls));
}
