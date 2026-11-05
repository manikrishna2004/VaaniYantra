import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth } from '@/lib/api/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/v1/numbers — phone numbers owned by the API key's org.
export async function GET(req: Request) {
  const auth = await requireApiAuth(req, 'numbers:read');
  if (auth instanceof NextResponse) return auth;

  const numbers = await prisma.phoneNumber.findMany({
    where: { workspace: { orgId: auth.orgId } },
    select: {
      id: true,
      e164: true,
      label: true,
      provider: true,
      agentId: true,
      inboundEnabled: true,
      webhookConfigured: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ numbers });
}
