import { prisma } from '@/lib/db';

// Erasing a patient.
//
// The shape of this is set by two decisions already written into the schema and
// not up for re-litigation here:
//
//   - `Appointment.contactId` is SetNull, "deleting a patient record must never
//     quietly delete their appointment history". A clinic needs its own booking
//     and billing history to survive a patient asking to be forgotten.
//   - `Contact.guardian` is SetNull, "deleting a guardian must not delete a
//     child's medical record".
//
// So this is not a cascade. It erases the *person* — identity, clinical record,
// portal access — and leaves the operational rows standing with the identity
// scrubbed out of them. What comes back is a summary the caller can show and
// audit, because "we deleted them" is not a checkable claim and the counts are.
//
// What the database already handles on `contact.delete`, via onDelete Cascade:
// Allergy, VisitRecord (and beneath it PrescriptionItem and VisitDocument),
// PortalLogin, PortalChatTurn. Those are not repeated here — duplicating a
// cascade in application code is how the two drift apart.

/** What an anonymised appointment shows instead of the patient's name. */
export const ERASED_PATIENT_NAME = 'Deleted patient';

export type ErasePatientOutcome =
  | {
      ok: true;
      appointmentsAnonymised: number;
      whatsappTurnsDeleted: number;
      portalOtpsDeleted: number;
      /** True when the number belongs to other patients too, so it was kept. */
      phoneSharedWithOthers: boolean;
    }
  | {
      ok: false;
      reason: 'has_dependents';
      dependents: number;
    };

/**
 * Erase one patient. Everything happens in a single transaction: a half-erased
 * patient — record gone, name still on the appointments — is worse than either
 * outcome, because nothing downstream can tell it happened.
 */
export async function erasePatient(contact: {
  id: string;
  orgId: string;
  phone: string;
}): Promise<ErasePatientOutcome> {
  // A household primary still holding dependents is refused rather than
  // handled. The FK would SetNull their `guardianContactId` and leave children
  // with `dependentKey` set but no guardian — a state household.ts says cannot
  // exist, and one that silently detaches a child's medical record from the
  // adult responsible for it. Staff delete or reassign the dependents first.
  const dependents = await prisma.contact.count({ where: { guardianContactId: contact.id } });
  if (dependents > 0) return { ok: false, reason: 'has_dependents', dependents };

  // Is this number still in use by someone else — a household primary, a
  // sibling, a parent on the same handset? If it is, anything keyed by phone
  // rather than by contact id belongs to them as much as to the person being
  // erased, and deleting it would take a live patient's data with it.
  const othersOnPhone = await prisma.contact.count({
    where: { orgId: contact.orgId, phone: contact.phone, id: { not: contact.id } },
  });
  const phoneSharedWithOthers = othersOnPhone > 0;

  return prisma.$transaction(async (tx) => {
    // Keep the booking, lose the patient. `patientNo` is a denormalised copy of
    // the UHID and has to go with the name — left behind it would point at the
    // deleted record and, worse, stay stable enough to re-identify someone
    // across a clinic's exports.
    const appointments = await tx.appointment.updateMany({
      where: { contactId: contact.id },
      data: {
        customerName: ERASED_PATIENT_NAME,
        customerNumber: null,
        patientNo: null,
        contactId: null,
      },
    });

    let whatsappTurnsDeleted = 0;
    let portalOtpsDeleted = 0;
    if (!phoneSharedWithOthers) {
      // WhatsappTurn.waId is E.164 without the leading '+'; PortalOtp.phone
      // keeps it. Both are keyed by number alone — there is no contact id to
      // join on — which is exactly why the shared-number check above has to
      // gate them.
      const waId = contact.phone.replace(/^\+/, '');
      whatsappTurnsDeleted = (
        await tx.whatsappTurn.deleteMany({ where: { orgId: contact.orgId, waId } })
      ).count;
      portalOtpsDeleted = (
        await tx.portalOtp.deleteMany({ where: { orgId: contact.orgId, phone: contact.phone } })
      ).count;
    }

    // Last, so a failure anywhere above rolls back with the patient intact.
    // This is what cascades the clinical record.
    await tx.contact.delete({ where: { id: contact.id } });

    return {
      ok: true as const,
      appointmentsAnonymised: appointments.count,
      whatsappTurnsDeleted,
      portalOtpsDeleted,
      phoneSharedWithOthers,
    };
  });
}
