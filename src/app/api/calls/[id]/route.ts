import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { stripInternalCost } from '@/lib/calls/redact';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, props: Params) {
  const params = await props.params;
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'call:read')) {
    return NextResponse.json({ error: 'You do not have access to this call.' }, { status: 403 });
  }

  const call = await prisma.call.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: {
      agent: { select: { id: true, name: true, language: true, voice: true } },
      phoneNumber: { select: { e164: true, label: true } },
      transcript: { orderBy: { atMs: 'asc' } },
    },
  });
  if (!call) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // `include` returns every scalar on the model, and that now includes what the
  // call cost us to run. See lib/calls/redact.
  return NextResponse.json(stripInternalCost(call));
}
