import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { cancelAppointmentRecord } from '@/lib/appointments';
import { readBookingConfig, rescheduleBooking } from '@/lib/connectors/booking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Move an appointment to a new time.
 *
 * Delegates to rescheduleBooking() — the same function the phone agent and the
 * patient chatbot call — rather than moving the row here. That function holds
 * the per-(org, doctor, day) advisory lock, the overlap re-check, the
 * reminder-flag reset and the rollback that restores the row if Google rejects
 * the patch. The sibling booking route states the rule (route.ts:41-50): a
 * second write path drifts from all of that within a release.
 */
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:write');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { startISO?: unknown };
  const newStartISO = typeof body.startISO === 'string' ? body.startISO : '';
  if (!newStartISO || Number.isNaN(Date.parse(newStartISO))) {
    return NextResponse.json({ error: 'Pick a valid date and time.' }, { status: 400 });
  }

  // The booking config carries the slot capacity and timezone the move is
  // checked against. Same resolution the POST route uses: the workspace's first
  // booking-enabled agent.
  const agents = await prisma.agent.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { createdAt: 'asc' } });
  const agent = agents.find((a) => readBookingConfig(a).enabled);
  if (!agent) return NextResponse.json({ error: 'No agent has appointment booking enabled.' }, { status: 409 });

  // No customerNumber: staff are authenticated and moving someone else's
  // appointment is their job. workspaceId is what confines them instead.
  const result = (await rescheduleBooking(readBookingConfig(agent), { appointmentId: params.id, newStartISO }, {
    orgId: ctx.org.id,
    workspaceId: ctx.workspace.id,
  })) as { ok?: boolean; error?: string; when?: string };

  if (!result.ok) {
    // A taken slot is a conflict, not a bad request — the UI distinguishes them.
    const taken = typeof result.error === 'string' && result.error.toLowerCase().includes('taken');
    return NextResponse.json({ error: result.error ?? 'Could not move the appointment.' }, { status: taken ? 409 : 400 });
  }

  await audit(ctx, 'appointment.rescheduled', {
    targetType: 'Appointment',
    targetId: params.id,
    metadata: { when: result.when },
    req,
  });
  return NextResponse.json(result);
}

// Owner cancels an appointment from the dashboard: removes the calendar event,
// marks it cancelled (stopping reminders), and notifies the customer.
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:write');
  if (denied) return denied;

  const res = await cancelAppointmentRecord(params.id, {
    by: 'staff',
    orgId: ctx.org.id,
    workspaceId: ctx.workspace.id,
  });
  if (!res.ok) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 });

  await audit(ctx, 'appointment.cancelled', {
    targetType: 'Appointment',
    targetId: params.id,
    metadata: { when: res.when, service: res.service },
    req,
  });
  return NextResponse.json({ ok: true });
}
