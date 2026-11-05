import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Switch the active workspace (and its org). Validates the caller is a member
// of the target workspace's organization.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { workspaceId?: string };
  if (!body.workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  const ws = await prisma.workspace.findUnique({
    where: { id: body.workspaceId },
    include: { org: { include: { memberships: { where: { userId: ctx.user.id } } } } },
  });
  if (!ws || ws.org.memberships.length === 0) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  await prisma.user.update({
    where: { id: ctx.user.id },
    data: { activeOrgId: ws.orgId, activeWorkspaceId: ws.id },
  });

  return NextResponse.json({ ok: true });
}
