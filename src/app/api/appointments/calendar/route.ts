import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { hasPermission } from '@/lib/auth/permissions';
import { doctorScope } from '@/lib/auth/tenant';
import { listDoctors, doctorForUser, timeOffBusy } from '@/lib/doctors';
import { resolveDoctorCalendar, freeBusy } from '@/lib/calendar';
import { refreshAccessToken } from '@/lib/google-oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Everything the calendar grid draws for one window.
 *
 * Three kinds of block, and the distinction matters to the UI:
 *   • appointments — ours, draggable
 *   • timeOff      — ours, shown as unavailable
 *   • external     — the doctor's other Google events, read-only grey. Sourced
 *                    from free/busy, which returns opaque intervals with no
 *                    titles, so a doctor's personal life never leaks to the
 *                    front desk. That is a feature, not a limitation.
 *
 * Scoping: staff see any doctor; a DOCTOR sees only themselves, enforced by
 * ignoring the requested doctorId entirely rather than validating it — there is
 * then no id a doctor can pass to reach a colleague.
 */
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const staff = hasPermission(ctx.role, 'call:read');
  const selfOnly = !staff && hasPermission(ctx.role, 'calendar:read_self');
  if (!staff && !selfOnly) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const from = new Date(Date.parse(params.get('from') ?? '') || Date.now() - 86400000);
  const to = new Date(Date.parse(params.get('to') ?? '') || Date.now() + 7 * 86400000);

  const me = await doctorForUser(ctx.org.id, ctx.user.id);
  if (selfOnly && !me) {
    // Signed in as a DOCTOR but nobody has set up a doctor record for them yet.
    // An empty calendar with an explanation beats a 403 they cannot act on.
    return NextResponse.json({ doctors: [], appointments: [], timeOff: [], external: [], needsSetup: true });
  }

  const requested = params.get('doctorId') || null;
  // A doctor's own id is derived, never taken from the query — but staff may
  // name any doctor, and this id then reaches a time-off query and a calendar
  // lookup below that are both keyed on doctorId alone with no tenant filter.
  // Validating it here once is what keeps those two safe: without it, knowing a
  // Doctor.id at another clinic was enough to read that clinic's leave rows,
  // titles and reasons included. 404 rather than 403, so this does not confirm
  // that someone else's doctor exists.
  if (requested && !selfOnly) {
    const inOrg = await prisma.doctor.findFirst({
      where: { id: requested, orgId: ctx.org.id },
      select: { id: true },
    });
    if (!inOrg) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const doctorId = selfOnly ? me!.id : requested;

  const appointments = await prisma.appointment.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      startAt: { lt: to },
      endAt: { gt: from },
      // doctorScope throws on an empty id rather than silently widening, so it is
      // only reached once we actually have one.
      ...(doctorId ? doctorScope(doctorId) : {}),
    },
    orderBy: { startAt: 'asc' },
    take: 500,
    select: {
      id: true,
      customerName: true,
      customerNumber: true,
      patientNo: true,
      contactId: true,
      doctorId: true,
      expertName: true,
      service: true,
      startAt: true,
      endAt: true,
      timezone: true,
      status: true,
    },
  });

  const doctors = staff ? await listDoctors(ctx.org.id) : [];
  const timeOff = doctorId
    ? await prisma.doctorTimeOff.findMany({
        where: { doctorId, startAt: { lt: to }, endAt: { gt: from } },
        orderBy: { startAt: 'asc' },
      })
    : [];

  // External Google events, only for a doctor linked to a connected account.
  // Best-effort: a calendar that will not answer must not take the whole grid
  // down with it, so this degrades to an empty list.
  let external: { start: string; end: string }[] = [];
  if (doctorId) {
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { userId: true } });
    if (doctor?.userId) {
      try {
        const resolved = await resolveDoctorCalendar(ctx.org.id, doctor.userId);
        if (resolved) {
          const token = await refreshAccessToken(resolved.cfg.refreshToken);
          const busy = await freeBusy(token, resolved.cfg.calendarId || 'primary', from.toISOString(), to.toISOString());
          external = busy.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() }));
        }
      } catch (err) {
        console.error('[calendar] external busy unavailable', err);
      }
    }
  }

  return NextResponse.json({
    doctors,
    appointments,
    timeOff,
    external,
    selfDoctorId: me?.id ?? null,
    canManage: hasPermission(ctx.role, 'call:write') || hasPermission(ctx.role, 'calendar:write_self'),
  });
}
