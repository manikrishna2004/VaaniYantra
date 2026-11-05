import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth, serializeCall } from '@/lib/api/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/v1/calls/:id — a single call with its full transcript.
export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireApiAuth(req, 'calls:read');
  if (auth instanceof NextResponse) return auth;

  const call = await prisma.call.findFirst({
    where: { id: params.id, workspace: { orgId: auth.orgId } },
    include: {
      agent: { select: { id: true, name: true } },
      transcript: { orderBy: { atMs: 'asc' }, select: { role: true, text: true, atMs: true } },
    },
  });
  if (!call) return NextResponse.json({ error: 'Call not found' }, { status: 404 });

  return NextResponse.json({ call: serializeCall(call, { transcript: true }) });
}
