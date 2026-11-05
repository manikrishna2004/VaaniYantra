import { describe, it, expect, vi, beforeEach } from 'vitest';

// Erasing a patient: the person goes, the clinic's booking history stays with
// the identity scrubbed out of it. Set by two decisions already in the schema —
// Appointment.contactId is SetNull ("deleting a patient record must never
// quietly delete their appointment history") and Contact.guardian is SetNull
// ("deleting a guardian must not delete a child's medical record").

const tx = vi.hoisted(() => ({
  appointment: { updateMany: vi.fn(async () => ({ count: 0 })) },
  whatsappTurn: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  portalOtp: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  contact: { delete: vi.fn(async () => ({})) },
}));

const prismaMock = vi.hoisted(() => ({
  contact: { count: vi.fn(async () => 0) },
  $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { erasePatient, ERASED_PATIENT_NAME } from '@/lib/patients/erase';

const patient = { id: 'c1', orgId: 'o1', phone: '+919876543210' };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.contact.count.mockResolvedValue(0);
  tx.appointment.updateMany.mockResolvedValue({ count: 0 });
  tx.whatsappTurn.deleteMany.mockResolvedValue({ count: 0 });
  tx.portalOtp.deleteMany.mockResolvedValue({ count: 0 });
});

describe('erasePatient — the household guard', () => {
  it('refuses to erase a guardian who still has dependents', async () => {
    // The FK would SetNull their guardianContactId, leaving a child with
    // dependentKey set and no guardian — a state household.ts says cannot exist.
    prismaMock.contact.count.mockResolvedValueOnce(2);

    const out = await erasePatient(patient);

    expect(out).toEqual({ ok: false, reason: 'has_dependents', dependents: 2 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(tx.contact.delete).not.toHaveBeenCalled();
  });
});

describe('erasePatient — what survives', () => {
  it('keeps appointments but strips every identifying field', async () => {
    tx.appointment.updateMany.mockResolvedValue({ count: 3 });

    const out = await erasePatient(patient);

    expect(tx.appointment.updateMany).toHaveBeenCalledWith({
      where: { contactId: 'c1' },
      data: {
        customerName: ERASED_PATIENT_NAME,
        customerNumber: null,
        // patientNo is a denormalised UHID copy — left behind it would both
        // point at a deleted record and re-identify the person across exports.
        patientNo: null,
        contactId: null,
      },
    });
    expect(out).toMatchObject({ ok: true, appointmentsAnonymised: 3 });
  });

  it('deletes the patient last, so a failure above rolls back intact', async () => {
    const order: string[] = [];
    tx.appointment.updateMany.mockImplementation(async () => {
      order.push('appointments');
      return { count: 1 };
    });
    tx.contact.delete.mockImplementation(async () => {
      order.push('contact');
      return {};
    });

    await erasePatient(patient);

    expect(order).toEqual(['appointments', 'contact']);
  });
});

describe('erasePatient — phone-keyed data on a shared number', () => {
  it('deletes WhatsApp turns and codes when the number is theirs alone', async () => {
    prismaMock.contact.count
      .mockResolvedValueOnce(0) // dependents
      .mockResolvedValueOnce(0); // others on this phone
    tx.whatsappTurn.deleteMany.mockResolvedValue({ count: 9 });
    tx.portalOtp.deleteMany.mockResolvedValue({ count: 2 });

    const out = await erasePatient(patient);

    // waId is E.164 without the '+'; PortalOtp.phone keeps it.
    expect(tx.whatsappTurn.deleteMany).toHaveBeenCalledWith({
      where: { orgId: 'o1', waId: '919876543210' },
    });
    expect(tx.portalOtp.deleteMany).toHaveBeenCalledWith({
      where: { orgId: 'o1', phone: '+919876543210' },
    });
    expect(out).toMatchObject({ ok: true, whatsappTurnsDeleted: 9, portalOtpsDeleted: 2 });
  });

  it('leaves them alone when a family shares the handset', async () => {
    // Families share one mobile constantly. These tables key on the number and
    // have no contact id, so deleting them would take a live patient's data.
    prismaMock.contact.count
      .mockResolvedValueOnce(0) // dependents
      .mockResolvedValueOnce(1); // a sibling on the same number

    const out = await erasePatient(patient);

    expect(tx.whatsappTurn.deleteMany).not.toHaveBeenCalled();
    expect(tx.portalOtp.deleteMany).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: true,
      phoneSharedWithOthers: true,
      whatsappTurnsDeleted: 0,
      portalOtpsDeleted: 0,
    });
    // The patient themselves still goes.
    expect(tx.contact.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });
});
