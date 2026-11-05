import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth } from '@/lib/api/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/v1/agents/:id — a single agent owned by the API key's org.
export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireApiAuth(req, 'agents:read');
  if (auth instanceof NextResponse) return auth;

  const agent = await prisma.agent.findFirst({
    where: { id: params.id, workspace: { orgId: auth.orgId } },
    select: {
      id: true,
      name: true,
      language: true,
      voice: true,
      status: true,
      direction: true,
      greeting: true,
      createdAt: true,
    },
  });
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  return NextResponse.json({ agent });
}
