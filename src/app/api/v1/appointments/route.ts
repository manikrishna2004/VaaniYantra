import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth, paging } from '@/lib/api/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/v1/appointments — booked appointments for the org. Filters:
// ?status=CONFIRMED|CANCELLED , ?upcoming=true , paginated with ?limit=&offset=.
export async function GET(req: Request) {
  const auth = await requireApiAuth(req, 'appointments:read');
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const { take, skip, limit, offset } = paging(url);
  const status = url.searchParams.get('status')?.toUpperCase();
  const upcoming = url.searchParams.get('upcoming') === 'true';

  const where: any = { orgId: auth.orgId };
  if (status === 'CONFIRMED' || status === 'CANCELLED') where.status = status;
  if (upcoming) where.startAt = { gte: new Date() };

  const [items, total] = await Promise.all([
    prisma.appointment.findMany({ where, orderBy: { startAt: upcoming ? 'asc' : 'desc' }, take, skip }),
    prisma.appointment.count({ where }),
  ]);

  const appointments = items.map((a) => ({
    id: a.id,
    customerName: a.customerName,
    customerNumber: a.customerNumber,
    // Additive: the patient this booking belongs to, so an integrated clinic
    // can reconcile against its own records without matching phone strings.
    contactId: a.contactId,
    patientNo: a.patientNo,
    service: a.service,
    expertName: a.expertName,
    startAt: a.startAt,
    endAt: a.endAt,
    timezone: a.timezone,
    status: a.status,
    channel: a.channel,
    agentId: a.agentId,
    createdAt: a.createdAt,
  }));

  return NextResponse.json({ appointments, total, limit, offset });
}
