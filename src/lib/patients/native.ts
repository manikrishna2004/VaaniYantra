import { prisma } from '@/lib/db';
import { encryptBytes, decryptBytes } from '@/lib/crypto';
import type {
  PatientDataProvider,
  ProviderCapabilities,
  ProviderKind,
  VisitInput,
  VisitsResult,
} from './types';

// The provider backed by our own Postgres.
//
// Serves two org modes that share all their read code and differ only in who is
// allowed to WRITE:
//   native — we are the system of record; staff file consultations in our UI.
//   push   — the clinic's own system is authoritative and mirrors records into
//            these same tables over the v1 API. Reads are identical; our write
//            surface is closed off, because a staff edit here would be silently
//            overwritten by their next push and the divergence would only
//            surface as a patient being told the wrong dosage.
//
// Mirroring rather than reading through on the push path is deliberate: a
// patient opening their prescription at 10pm must not depend on the clinic's
// server being awake, and a prescription doesn't change after it is written.

export const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MB per file
export const MAX_DOCS_PER_VISIT = 6;
export const ALLOWED_DOC_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
];

const VISIT_SELECT = {
  id: true,
  visitedAt: true,
  expertName: true,
  service: true,
  diagnosis: true,
  prescription: true,
  advice: true,
  followUpAt: true,
  // Fetched, then used to REDACT `diagnosis` on the patient path below. Prisma
  // cannot conditionally omit a scalar per row, so the alternative would be a
  // second select — and the entire value of this one is that the patient-facing
  // allow-list is auditable in a single place.
  diagnosisSharedAt: true,
  // Structured drug lines. Ordered here rather than at every call site so the
  // pharmacist's reading order survives into the portal and the chatbot.
  items: {
    orderBy: { sortOrder: 'asc' },
    select: {
      drug: true,
      strength: true,
      dose: true,
      frequency: true,
      durationDays: true,
      route: true,
      instructions: true,
    },
  },
  documents: { select: { id: true, name: true, mimeType: true, sizeBytes: true } },
} as const;

export class NativePatientProvider implements PatientDataProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  constructor(kind: 'native' | 'push' = 'native', systemOfRecord?: string) {
    this.kind = kind;
    const owned = kind === 'native';
    this.capabilities = {
      canWriteRecords: owned,
      canWriteContacts: owned,
      canReadDocuments: true,
      canWriteDocuments: owned,
      // Booking stays ours in both modes — it is driven by Google Calendar and
      // our own Appointment table, not by the clinic's record system. An
      // integrated clinic that wants bookings in their PMS receives them as
      // write-back webhook events.
      canWriteAppointments: true,
      systemOfRecord: systemOfRecord || (owned ? 'VaaniYantra' : 'your clinic system'),
    };
  }

  async listPatientVisits(contactId: string, opts: { take?: number } = {}): Promise<VisitsResult> {
    try {
      const rows = await prisma.visitRecord.findMany({
        where: { contactId, sharedWithContact: true },
        orderBy: { visitedAt: 'desc' },
        take: opts.take ?? 20,
        select: VISIT_SELECT,
      });

      // ⚠ THE DATABASE IS NOT ENFORCING THIS. The raw diagnosis text IS fetched
      // into memory above and dropped here, three lines from the
      // `sharedWithContact` filter so the whole "what a patient may see" policy
      // reads in one place. Anything that bypasses this mapping bypasses the
      // hold — do not query VisitRecord directly on a patient-facing path.
      const visits = rows.map(({ diagnosisSharedAt, ...v }) => ({
        ...v,
        diagnosis: diagnosisSharedAt ? v.diagnosis : null,
        // Existence, not content. A patient told "your doctor is still
        // reviewing this" is better served than one shown a silent gap that
        // reads as a broken app.
        diagnosisPending: !diagnosisSharedAt && Boolean(v.diagnosis),
      }));
      return visits.length ? { status: 'ok', visits } : { status: 'empty' };
    } catch (err) {
      // Our own database being unreachable is exactly the case that must not
      // read as "this patient has no prescriptions".
      console.error('[patients/native] listPatientVisits failed', err);
      return { status: 'unavailable', reason: 'records database unreachable' };
    }
  }

  async listStaffVisits(contactId: string, opts: { take?: number } = {}): Promise<VisitsResult> {
    try {
      // Staff see the diagnosis whether or not it has been released — the hold
      // is about what reaches the PATIENT, not about hiding it from the clinic.
      const rows = await prisma.visitRecord.findMany({
        where: { contactId },
        orderBy: { visitedAt: 'desc' },
        take: opts.take ?? 50,
        select: VISIT_SELECT,
      });
      const visits = rows.map(({ diagnosisSharedAt, ...v }) => ({
        ...v,
        diagnosisPending: !diagnosisSharedAt && Boolean(v.diagnosis),
      }));
      return visits.length ? { status: 'ok', visits } : { status: 'empty' };
    } catch (err) {
      console.error('[patients/native] listStaffVisits failed', err);
      return { status: 'unavailable', reason: 'records database unreachable' };
    }
  }

  async createVisit(contactId: string, input: VisitInput): Promise<{ id: string } | { error: string }> {
    if (!this.capabilities.canWriteRecords) {
      return { error: `Records are managed in ${this.capabilities.systemOfRecord} and cannot be edited here.` };
    }
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { orgId: true, workspaceId: true },
    });
    if (!contact) return { error: 'Patient not found.' };

    const row = await prisma.visitRecord.create({
      data: {
        orgId: contact.orgId,
        workspaceId: contact.workspaceId,
        contactId,
        visitedAt: input.visitedAt ?? new Date(),
        expertName: input.expertName ?? null,
        service: input.service ?? null,
        diagnosis: input.diagnosis ?? null,
        prescription: input.prescription ?? null,
        advice: input.advice ?? null,
        followUpAt: input.followUpAt ?? null,
        internalNotes: input.internalNotes ?? null,
        sharedWithContact: input.sharedWithContact ?? true,
        externalId: input.externalId ?? null,
        source: this.kind,
      },
      select: { id: true },
    });
    return row;
  }

  async readDocument(
    documentId: string,
    scope: { orgId: string; contactId?: string },
  ): Promise<{ name: string; mimeType: string; buffer: Buffer } | null> {
    const doc = await prisma.visitDocument.findFirst({
      where: {
        id: documentId,
        orgId: scope.orgId,
        // Patient-side reads additionally require the document to hang off one
        // of THEIR shared visits, so a valid session for one patient cannot
        // fetch another patient's scan by guessing an id.
        ...(scope.contactId ? { visit: { contactId: scope.contactId, sharedWithContact: true } } : {}),
      },
      select: { name: true, mimeType: true, data: true },
    });
    if (!doc) return null;
    try {
      return { name: doc.name, mimeType: doc.mimeType, buffer: decryptBytes(Buffer.from(doc.data)) };
    } catch (err) {
      console.error('[patients/native] document decrypt failed', documentId, err);
      return null;
    }
  }
}

/** Store an uploaded prescription/report, encrypted. Native-storage concern. */
export async function attachDocument(input: {
  visitId: string;
  orgId: string;
  name: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ id: string } | { error: string }> {
  if (input.buffer.length === 0) return { error: 'That file is empty.' };
  if (input.buffer.length > MAX_DOC_BYTES) return { error: 'Each file must be 5 MB or smaller.' };
  if (!ALLOWED_DOC_TYPES.includes(input.mimeType)) {
    return { error: 'Upload a PDF or an image (JPEG, PNG, WebP, HEIC).' };
  }
  const count = await prisma.visitDocument.count({ where: { visitId: input.visitId } });
  if (count >= MAX_DOCS_PER_VISIT) {
    return { error: `A visit can hold at most ${MAX_DOCS_PER_VISIT} attachments.` };
  }

  return prisma.visitDocument.create({
    data: {
      visitId: input.visitId,
      orgId: input.orgId,
      name: input.name.slice(0, 200),
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      data: new Uint8Array(encryptBytes(input.buffer)),
    },
    select: { id: true },
  });
}
