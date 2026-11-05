import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth, paging, serializeCall } from '@/lib/api/v1';
import { placeOutboundCall } from '@/lib/calls/place-outbound';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/v1/calls — list calls for the org. Filters: ?direction=INBOUND|OUTBOUND
// &status=COMPLETED&agentId=… , paginated with ?limit=&offset=.
export async function GET(req: Request) {
  const auth = await requireApiAuth(req, 'calls:read');
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const { take, skip, limit, offset } = paging(url);
  const direction = url.searchParams.get('direction')?.toUpperCase();
  const status = url.searchParams.get('status')?.toUpperCase();
  const agentId = url.searchParams.get('agentId') || undefined;

  const where: any = { workspace: { orgId: auth.orgId } };
  if (direction === 'INBOUND' || direction === 'OUTBOUND') where.direction = direction;
  if (status) where.status = status;
  if (agentId) where.agentId = agentId;

  const [items, total] = await Promise.all([
    prisma.call.findMany({
      where,
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    prisma.call.count({ where }),
  ]);

  return NextResponse.json({ calls: items.map((c) => serializeCall(c)), total, limit, offset });
}

// POST /api/v1/calls — place an outbound call. Body: { agentId, to, fromNumberId? }.
export async function POST(req: Request) {
  const auth = await requireApiAuth(req, 'calls:write');
  if (auth instanceof NextResponse) return auth;

  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string;
    to?: string;
    fromNumberId?: string;
  };
  const agentId = body.agentId?.trim() ?? '';
  const to = body.to?.trim() ?? '';
  if (!agentId || !to) {
    return NextResponse.json({ error: 'agentId and to are required.' }, { status: 400 });
  }
  if (!/^\+?[1-9]\d{6,15}$/.test(to)) {
    return NextResponse.json({ error: 'to must be a valid phone number (E.164).' }, { status: 400 });
  }

  const result = await placeOutboundCall({
    orgId: auth.orgId,
    agentId,
    to,
    fromNumberId: body.fromNumberId ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(serializeCall(result.call), { status: 201 });
}
