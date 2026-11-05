import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { hasPermission } from '@/lib/auth/permissions';
import { doctorScope } from '@/lib/auth/tenant';
import { doctorForUser } from '@/lib/doctors';
import { audit } from '@/lib/audit';
import { toE164 } from '@/lib/phone';
import { createBooking, readBookingConfig } from '@/lib/connectors/booking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// List the workspace's appointments (upcoming + recent past), for the staff
// dashboard. Cancellation is a separate DELETE on /[id].
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;

  // A DOCTOR reaches this list too, but must see only their own bookings.
  //
  // `call:read` is clinic-wide and stays the staff gate. A doctor qualifies
  // through `calendar:read_self` instead, and the row filter below is what makes
  // that permission mean what its name says — without it, granting a doctor read
  // access to the appointments list would hand them every patient booking in the
  // clinic.
  const staff = hasPermission(ctx.role, 'call:read');
  const selfOnly = !staff && hasPermission(ctx.role, 'calendar:read_self');
  if (!staff && !selfOnly) {
    const denied = deny(ctx, 'call:read');
    if (denied) return denied;
  }

  let scope: { doctorId?: string } = {};
  if (selfOnly) {
    const me = await doctorForUser(ctx.org.id, ctx.user.id);
    // No doctor record yet: an empty list, never the whole clinic's.
    if (!me) return NextResponse.json([]);
    scope = doctorScope(me.id);
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000); // include yesterday's
  const appointments = await prisma.appointment.findMany({
    where: { workspaceId: ctx.workspace.id, startAt: { gte: since }, ...scope },
    orderBy: { startAt: 'asc' },
    take: 200,
    select: {
      id: true,
      customerName: true,
      customerNumber: true,
      patientNo: true,
      contactId: true,
      expertName: true,
      service: true,
      startAt: true,
      endAt: true,
      timezone: true,
      status: true,
      confirmationDelivered: true,
    },
  });
  return NextResponse.json(appointments);
}

/**
 * Book an appointment from the front desk.
 *
 * Delegates to createBooking() rather than writing an Appointment row of its
 * own. That is the whole point: createBooking is the single place that claims a
 * slot under the advisory lock, creates the calendar event (and releases the
 * slot if that fails), registers the patient and allocates their number, sends
 * the confirmation, fires the outcome and dispatches the webhook. A second
 * write path would drift from all of it within a release.
 */
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:write');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string;
    contactId?: string;
    customerName?: string;
    customerNumber?: string;
    startISO?: string;
    expert?: string;
    notes?: string;
  };

  const startISO = (body.startISO ?? '').trim();
  if (!startISO || Number.isNaN(Date.parse(startISO))) {
    return NextResponse.json({ error: 'Pick a valid date and time.' }, { status: 400 });
  }

  const agent = await resolveBookingAgent(ctx.workspace.id, body.agentId);
  if (!agent) {
    return NextResponse.json(
      { error: 'No agent has appointment booking enabled. Turn it on for an agent under Agents → Bookings.' },
      { status: 400 },
    );
  }

  // An existing patient can be booked by id; otherwise we need a name, and a
  // number if the patient is to get a confirmation and a chatbot link.
  let customerName = (body.customerName ?? '').trim();
  let customerNumber = body.customerNumber ? toE164(body.customerNumber) : null;
  if (body.customerNumber && !customerNumber) {
    return NextResponse.json({ error: 'Enter a valid mobile number, e.g. +91 98765 43210.' }, { status: 400 });
  }

  if (body.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: body.contactId, orgId: ctx.org.id },
      select: { id: true, name: true, phone: true },
    });
    if (!contact) return NextResponse.json({ error: 'That patient no longer exists.' }, { status: 400 });
    // The patient record wins over anything typed into the form — staff picked
    // this person deliberately.
    customerName = contact.name;
    customerNumber = contact.phone;
  }

  if (!customerName) return NextResponse.json({ error: "Enter the patient's name." }, { status: 400 });

  const cfg = readBookingConfig(agent);
  const result = (await createBooking(cfg, {
    orgId: ctx.org.id,
    workspaceId: ctx.workspace.id,
    agent,
    callId: null,
    contactId: body.contactId ?? null,
    customerName,
    customerNumber,
    startISO,
    expert: body.expert,
    notes: body.notes,
    source: 'staff',
  })) as { ok?: boolean; error?: string; appointmentId?: string; patientNo?: string | null; when?: string };

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not book that appointment.' }, { status: 409 });
  }

  await audit(ctx, 'appointment.created', {
    targetType: 'Appointment',
    targetId: result.appointmentId,
    metadata: { patientNo: result.patientNo ?? null, when: result.when ?? null },
    req,
  });

  return NextResponse.json(result, { status: 201 });
}

/**
 * The agent whose booking settings (calendar, service, duration, doctors) this
 * booking should use. Explicit when staff picked one, else the workspace's
 * first booking-enabled agent — most clinics have exactly one.
 */
async function resolveBookingAgent(workspaceId: string, agentId?: string) {
  if (agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
    return agent && readBookingConfig(agent).enabled ? agent : null;
  }
  const agents = await prisma.agent.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  return agents.find((a) => readBookingConfig(a).enabled) ?? null;
}
