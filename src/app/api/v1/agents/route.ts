import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth } from '@/lib/api/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Public REST API: list agents for the organization that owns the API key.
// Authenticate with `Authorization: Bearer ck_live_...` or `x-api-key`.
export async function GET(req: Request) {
  const auth = await requireApiAuth(req, 'agents:read');
  if (auth instanceof NextResponse) return auth;
  const agents = await prisma.agent.findMany({
    where: { workspace: { orgId: auth.orgId } },
    select: {
      id: true,
      name: true,
      language: true,
      voice: true,
      status: true,
      direction: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ agents });
}
