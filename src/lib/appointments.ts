import { prisma } from '@/lib/db';
import { resolveDoctorCalendar, deleteEvent } from '@/lib/calendar';
import { refreshAccessToken } from '@/lib/google-oauth';
import { sendConfirmation } from '@/lib/connectors';
import { dispatchPatientEvent } from '@/lib/webhooks';
import { apptCancelledTemplate } from '@/lib/whatsapp-templates';

// Shared appointment helpers used by both the in-call tools (booking.ts) and the
// owner dashboard (api/appointments). One source of truth for cancellation so
// the calendar event, the record, reminders, and the customer message stay in
// sync wherever cancel is triggered.

function fmt(date: Date, tz?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Who is asking to cancel, and therefore what they are allowed to reach.
 *
 * A discriminated union rather than a bag of optional fields. The previous
 * shape spread its filters conditionally — `...(scope.customerNumber ? {…} : {})`
 * — which meant a scope built wrong, or built from an undefined variable,
 * silently degraded to "any appointment in this org". Making the bad state
 * unrepresentable is cheaper than remembering not to build it.
 *
 *   staff   — inside their own workspace
 *   caller  — a voice caller, identified by the number on the line. Household-
 *             wide by nature, and correctly so: they rang from that phone.
 *   patient — a signed-in portal user, scoped to the patients they may act for
 *             (themselves, plus dependents if they are the guardian).
 */
export type CancelScope =
  | { by: 'staff'; orgId: string; workspaceId: string }
  | { by: 'caller'; orgId: string; customerNumber: string }
  | { by: 'patient'; orgId: string; contactIds: string[]; legacyPhone?: string | null };

function cancelWhere(scope: CancelScope) {
  if (scope.by === 'staff') return { workspaceId: scope.workspaceId };
  if (scope.by === 'caller') return { customerNumber: scope.customerNumber };
  return {
    OR: [
      { contactId: { in: scope.contactIds } },
      // Legacy rows only. An appointment that names a patient is authoritative,
      // so the phone must not widen it — otherwise one sibling could cancel
      // another's booking just by sharing a handset.
      ...(scope.legacyPhone ? [{ contactId: null, customerNumber: scope.legacyPhone }] : []),
    ],
  };
}

// Cancel a CONFIRMED appointment: delete its calendar event, mark it CANCELLED
// (which stops reminders), and notify the patient.
export async function cancelAppointmentRecord(
  id: string,
  scope: CancelScope,
): Promise<{ ok: boolean; when?: string; service?: string }> {
  // A patient scope with nothing in it must never reach Prisma — an empty
  // `in: []` plus no legacy leg would match nothing today, but the guard is
  // about intent: a degenerate scope is a bug, not a query.
  if (scope.by === 'patient' && scope.contactIds.length === 0 && !scope.legacyPhone) {
    console.error('[appointments] refusing a cancel with an empty patient scope');
    return { ok: false };
  }

  const appt = await prisma.appointment.findFirst({
    where: {
      id,
      orgId: scope.orgId,
      status: 'CONFIRMED',
      ...cancelWhere(scope),
    },
  });
  if (!appt) return { ok: false };

  if (appt.calendarEventId) {
    try {
      // Delete from the account this was booked on. Using the clinic's shared
      // connection unconditionally would 404 on a doctor's own calendar — and
      // worse, where `calendarId` is the literal "primary" it would resolve to
      // somebody else's calendar entirely.
      const resolved = await resolveDoctorCalendar(scope.orgId, appt.calendarUserId);
      if (resolved) {
        const token = await refreshAccessToken(resolved.cfg.refreshToken);
        await deleteEvent(token, appt.calendarId || resolved.cfg.calendarId || 'primary', appt.calendarEventId);
      }
    } catch (e) {
      console.error('[appointments] calendar delete failed', e);
    }
  }

  await prisma.appointment.update({ where: { id: appt.id }, data: { status: 'CANCELLED' } });

  const when = fmt(appt.startAt, appt.timezone);
  if (appt.customerNumber) {
    // The clinic's name, so a cancellation arriving from the SHARED platform
    // sender still says who it is from. Only looked up when there is actually
    // someone to message.
    const business = await prisma.organization
      .findUnique({ where: { id: scope.orgId }, select: { name: true } })
      .then((o) => o?.name ?? null)
      .catch(() => null);
    void sendConfirmation(
      scope.orgId,
      appt.customerNumber,
      // SMS / free-text fallback body:
      `Your ${appt.service} on ${when} has been cancelled.`,
      // Passing no template here meant WhatsApp cancellations were sent as
      // business-initiated free text, which Meta rejects — so they always
      // silently fell back to SMS.
      apptCancelledTemplate({
        name: appt.customerName,
        business,
        service: appt.service,
        when,
      }),
    );
  }

  // Write-back, so the clinic's own system frees the slot too. Cancellations
  // matter more than bookings here: a slot their system still thinks is taken
  // is one they cannot sell.
  void dispatchPatientEvent(appt.workspaceId, 'appointment.cancelled', {
    id: appt.id,
    customerName: appt.customerName,
    customerNumber: appt.customerNumber,
    service: appt.service,
    expertName: appt.expertName,
    startAt: appt.startAt.toISOString(),
    endAt: appt.endAt.toISOString(),
    timezone: appt.timezone,
    status: 'CANCELLED',
    calendarEventId: appt.calendarEventId,
  });

  return { ok: true, when, service: appt.service };
}
