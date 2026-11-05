import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { doctorAccess } from '@/lib/doctors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Leave and blocks — the native replacement for the all-day Google "leave"
// event, which only ever worked for a doctor who had connected Google and was
// skipped entirely for multi-per-slot agents.

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;

  const access = await doctorAccess(ctx, id, 'read');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  // Default to the window the calendar actually shows rather than the whole
  // history: a doctor who books leave every month should not grow an unbounded
  // response.
  const params = new URL(req.url).searchParams;
  const from = Date.parse(params.get('from') ?? '') || Date.now() - 7 * 86400000;
  const to = Date.parse(params.get('to') ?? '') || Date.now() + 90 * 86400000;

  const rows = await prisma.doctorTimeOff.findMany({
    where: { doctorId: id, startAt: { lt: new Date(to) }, endAt: { gt: new Date(from) } },
    orderBy: { startAt: 'asc' },
    take: 200,
  });
  return NextResponse.json({ timeOff: rows });
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;

  const access = await doctorAccess(ctx, id, 'write');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = (await req.json().catch(() => ({}))) as {
    startISO?: unknown;
    endISO?: unknown;
    allDay?: unknown;
    title?: unknown;
    reason?: unknown;
  };
  const start = Date.parse(typeof body.startISO === 'string' ? body.startISO : '');
  const end = Date.parse(typeof body.endISO === 'string' ? body.endISO : '');
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return NextResponse.json({ error: 'Pick a start and end.' }, { status: 400 });
  }
  // A zero-length or inverted block would silently never match the overlap test
  // and the doctor would keep being offered — refuse it rather than store
  // something that looks saved and does nothing.
  if (end <= start) return NextResponse.json({ error: 'The end must be after the start.' }, { status: 400 });

  const row = await prisma.doctorTimeOff.create({
    data: {
      orgId: ctx.org.id,
      doctorId: id,
      startAt: new Date(start),
      endAt: new Date(end),
      allDay: body.allDay === true,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null,
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
    },
  });

  await audit(ctx, 'doctor.time_off_added', {
    targetType: 'Doctor',
    targetId: id,
    // Deliberately not the reason: it is private to the clinic and an audit log
    // is read by more people than a doctor's leave note is meant for.
    metadata: { from: row.startAt.toISOString(), to: row.endAt.toISOString(), allDay: row.allDay },
    req,
  });
  return NextResponse.json(row, { status: 201 });
}
