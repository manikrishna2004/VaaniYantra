import type { Agent, Contact, Portal } from '@prisma/client';
import { prisma } from '@/lib/db';
import { cancelAppointmentRecord } from '@/lib/appointments';
import {
  createBooking,
  findOpenSlots,
  readBookingConfig,
  type BookingConfig,
} from '@/lib/connectors/booking';
import { appointmentScope, viewableContactIds, isPrimary } from '@/lib/patients/household';
import type { CancelScope } from '@/lib/appointments';
import type { PatientDataProvider } from '@/lib/patients';
import type { ToolSpec } from '@/lib/adapters/llm';

// Tools the patient portal chatbot can call.
//
// These deliberately mirror the in-call booking tools and delegate to the same
// helpers in connectors/booking.ts, so booking by typing and booking by talking
// share one capacity guard, one confirmation and one owner alert. What differs
// is the identity model: on a call the customer is whoever is on the line, here
// it is the authenticated contact — so nothing takes a phone number as an
// argument. The model cannot act on anyone but the patient holding the session,
// which is what stops "cancel Ravi's appointment" from working.

export type PortalToolContext = {
  portal: Portal;
  contact: Contact;
  agent: Agent;
  cfg: BookingConfig;
};

export type PortalTool = {
  spec: ToolSpec;
  handler: (args: Record<string, unknown>, ctx: PortalToolContext) => Promise<Record<string, unknown>>;
};

/**
 * What a signed-in patient may cancel: themselves, plus their dependents if
 * they are the guardian. The legacy phone leg is offered only to a household
 * primary — see appointmentScope for why.
 */
async function patientCancelScope(contact: Contact): Promise<CancelScope> {
  return {
    by: 'patient',
    orgId: contact.orgId,
    contactIds: await viewableContactIds(contact),
    legacyPhone: isPrimary(contact) ? contact.phone : null,
  };
}

function fmtWhen(date: Date, tz?: string | null): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz || 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

const myAppointments: PortalTool = {
  spec: {
    name: 'my_appointments',
    description:
      "List the patient's own upcoming appointments. Call this before cancelling or rescheduling so you have the appointmentId.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  handler: async (_args, ctx) => {
    const household = await viewableContactIds(ctx.contact);
    const appts = await prisma.appointment.findMany({
      where: {
        ...(await appointmentScope(ctx.contact)),
        status: 'CONFIRMED',
        startAt: { gte: new Date() },
      },
      orderBy: { startAt: 'asc' },
      take: 5,
      include: { contact: { select: { name: true } } },
    });
    if (appts.length === 0) return { ok: true, appointments: [], message: 'No upcoming appointments.' };
    return {
      ok: true,
      appointments: appts.map((a) => ({
        appointmentId: a.id,
        service: a.service,
        expert: a.expertName ?? undefined,
        when: fmtWhen(a.startAt, a.timezone),
        // Whose appointment it is, but only when there is more than one person
        // in the household — otherwise the model has no way to tell a guardian's
        // own booking from their child's, and will cancel the wrong one.
        ...(household.length > 1 ? { for: a.contact?.name ?? a.customerName } : {}),
      })),
    };
  },
};

const checkAvailability: PortalTool = {
  spec: {
    name: 'check_availability',
    description:
      'Get real open appointment slots. Call this before offering the patient any times — never invent a time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Optional preferred date as YYYY-MM-DD. Omit for the next available slots.' },
        expert: { type: 'STRING', description: 'Optional preferred doctor/team member.' },
      },
    },
  },
  handler: (args, ctx) => findOpenSlots(ctx.cfg, ctx.contact.orgId, args),
};

const bookAppointment: PortalTool = {
  spec: {
    name: 'book_appointment',
    description:
      'Book a confirmed appointment at a slot returned by check_availability. Only call once the patient has agreed to a specific time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startISO: { type: 'STRING', description: 'The exact slot start in ISO-8601, copied from check_availability.' },
        expert: { type: 'STRING', description: 'Optional preferred doctor/team member.' },
        notes: { type: 'STRING', description: 'Optional reason for the visit.' },
      },
      required: ['startISO'],
    },
  },
  handler: (args, ctx) =>
    createBooking(ctx.cfg, {
      orgId: ctx.contact.orgId,
      workspaceId: ctx.portal.workspaceId,
      agent: ctx.agent,
      // No call to annotate — this booking was typed, not spoken.
      callId: null,
      // Identity comes from the session, never from the model.
      //
      // contactId is what makes a signed-in DEPENDENT's booking attach to them.
      // Without it createBooking re-resolves by phone and lands on the household
      // primary, so a child booking for themselves would silently file under
      // their parent.
      contactId: ctx.contact.id,
      customerNumber: ctx.contact.phone,
      customerName: ctx.contact.name,
      startISO: typeof args.startISO === 'string' ? args.startISO : '',
      expert: args.expert,
      notes: typeof args.notes === 'string' ? args.notes : '',
    }),
};

const cancelAppointment: PortalTool = {
  spec: {
    name: 'cancel_appointment',
    description: 'Cancel one of the patient\'s appointments. Use my_appointments first to get the appointmentId, and confirm with the patient before calling.',
    parameters: {
      type: 'OBJECT',
      properties: { appointmentId: { type: 'STRING', description: 'The id from my_appointments.' } },
      required: ['appointmentId'],
    },
  },
  handler: async (args, ctx) => {
    const id = typeof args.appointmentId === 'string' ? args.appointmentId : '';
    // Scoping by the session's phone number is what makes an id from another
    // patient's chat useless here.
    const res = await cancelAppointmentRecord(id, await patientCancelScope(ctx.contact));
    if (!res.ok) return { ok: false, error: 'I could not find that appointment.' };
    return { ok: true, cancelled: true, when: res.when };
  },
};

const rescheduleAppointment: PortalTool = {
  spec: {
    name: 'reschedule_appointment',
    description:
      'Move one of the patient\'s appointments to a new time. Use my_appointments for the id and check_availability for an open newStartISO.',
    parameters: {
      type: 'OBJECT',
      properties: {
        appointmentId: { type: 'STRING', description: 'The id from my_appointments.' },
        newStartISO: { type: 'STRING', description: 'The new slot start in ISO-8601, from check_availability.' },
      },
      required: ['appointmentId', 'newStartISO'],
    },
  },
  // Implemented as cancel + rebook rather than an in-place move: it reuses two
  // paths that already handle the calendar, the capacity lock and the customer
  // message correctly, and a patient who ends up with neither slot (rather than
  // a silently half-moved booking) is a failure the clinic can see.
  handler: async (args, ctx) => {
    const id = typeof args.appointmentId === 'string' ? args.appointmentId : '';
    const newStartISO = typeof args.newStartISO === 'string' ? args.newStartISO : '';
    if (!newStartISO || Number.isNaN(Date.parse(newStartISO))) return { ok: false, error: 'Invalid new time.' };

    const existing = await prisma.appointment.findFirst({
      where: { ...(await appointmentScope(ctx.contact)), id, status: 'CONFIRMED' },
    });
    if (!existing) return { ok: false, error: 'I could not find that appointment.' };

    const booked = await createBooking(ctx.cfg, {
      orgId: ctx.contact.orgId,
      workspaceId: ctx.portal.workspaceId,
      agent: ctx.agent,
      callId: null,
      contactId: ctx.contact.id,
      customerNumber: ctx.contact.phone,
      customerName: ctx.contact.name,
      startISO: newStartISO,
      expert: existing.expertName ?? undefined,
      notes: 'Rescheduled by the patient in the portal.',
    });
    // Only release the old slot once the new one is actually secured.
    if (booked.ok !== true) return booked;

    await cancelAppointmentRecord(existing.id, await patientCancelScope(ctx.contact)).catch((e) =>
      console.error('[portal] reschedule cleanup failed', e),
    );

    return { ok: true, rescheduled: true, when: booked.when };
  },
};

/**
 * Which tools this portal exposes. Booking tools appear only when every layer
 * says yes: the clinic allowed booking, the data provider permits appointment
 * writes, the agent has booking configured, and a calendar is actually
 * connected. Offering a tool that can only fail teaches the model to apologise
 * instead of helping.
 */
export async function portalTools(
  portal: Portal,
  agent: Agent | null,
  provider?: PatientDataProvider,
): Promise<PortalTool[]> {
  const tools: PortalTool[] = [];
  if (!agent || !portal.allowBooking) return tools;
  // An integrated clinic whose system owns scheduling gets bookings pushed to
  // it as webhook events instead; the chatbot must not also write them here.
  if (provider && !provider.capabilities.canWriteAppointments) return tools;

  const cfg = readBookingConfig(agent);
  if (!cfg.enabled) return tools;

  // No Google check any more. It used to withhold this whole list when the org
  // had no connected calendar — including the read-only `my_appointments`, so a
  // patient could not even see a booking the clinic had already made for them.
  // Appointments live in our database; Google is an optional mirror.
  tools.push(myAppointments, checkAvailability, bookAppointment, cancelAppointment, rescheduleAppointment);
  return tools;
}

export { readBookingConfig };
