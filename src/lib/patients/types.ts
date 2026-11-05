import type { RxItemLike } from '@/lib/patients/prescription';

// The patient-data seam.
//
// WHY THIS EXISTS
// Most clinics that buy this already run something — a practice-management
// system, a hospital HIS, or a spreadsheet somebody guards. A minority want us
// to be their system of record. Both have to work, and crucially they have to
// work through the SAME chatbot, the same portal and the same staff screens,
// or we end up maintaining two products and shipping bugs to one of them.
//
// So: every read and write of patient data goes through PatientDataProvider.
// Where the data physically lives becomes one org-level setting
// (Organization.patientProvider) instead of a branch in twenty call sites.
//
// This mirrors TelephonyProvider (src/lib/adapters/telephony/types.ts), which
// solved the same problem for Twilio/Exotel/Plivo — including the part that
// matters most: capability flags rather than thrown exceptions, so callers can
// ask "can I do this here?" instead of trying it and handling the failure.

export type ProviderKind = 'native' | 'push' | 'rest' | 'fhir';

/**
 * What this provider can actually do.
 *
 * Checked BEFORE offering an action — a chatbot tool that can only fail, or a
 * "Save" button that silently does nothing, is worse than the feature being
 * absent. When a clinic's own system owns the records, `canWriteRecords` is
 * false and our consultation form disappears rather than letting staff type
 * into something the next sync will overwrite.
 */
export type ProviderCapabilities = {
  /** Staff can create/edit visit records in OUR UI. False when they own the data. */
  canWriteRecords: boolean;
  /** Staff can add patients in OUR UI. */
  canWriteContacts: boolean;
  /** Prescription scans / reports are retrievable. */
  canReadDocuments: boolean;
  /** Attachments can be uploaded through our UI. */
  canWriteDocuments: boolean;
  /** Appointments can be booked/changed (portal chat + voice agent). */
  canWriteAppointments: boolean;
  /** Human-readable name of the system of record, for UI copy. */
  systemOfRecord: string;
};

export type PatientDocumentRef = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type PatientVisit = {
  id: string;
  visitedAt: Date;
  expertName: string | null;
  service: string | null;
  diagnosis: string | null;
  prescription: string | null;
  advice: string | null;
  followUpAt: Date | null;
  // The visit has a diagnosis the doctor has not released yet. Set instead of
  // the text, so a patient can be told "still being reviewed" rather than shown
  // a gap — and so the chatbot can be told not to guess at it.
  diagnosisPending?: boolean;
  // Structured drug lines. When non-empty these REPLACE `prescription` on every
  // surface — see renderPrescription() in src/lib/patients/prescription.ts.
  items?: RxItemLike[];
  documents: PatientDocumentRef[];
};

/**
 * The result of asking for a patient's records.
 *
 * `unavailable` is NOT a variation of empty, and collapsing the two is a
 * patient-safety bug: if a clinic's API times out and we hand the chatbot an
 * empty list, it will tell someone with a live prescription that nothing was
 * ever prescribed to them. Every caller must handle the third case explicitly.
 */
export type VisitsResult =
  | { status: 'ok'; visits: PatientVisit[] }
  | { status: 'empty' }
  | { status: 'unavailable'; reason: string };

export type PatientIdentity = {
  /** Our Contact id. Always present — we own portal identity even when integrated. */
  id: string;
  orgId: string;
  name: string;
  phone: string;
  /** Their id in the clinic's system, when integrated. */
  externalId: string | null;
};

export type VisitInput = {
  visitedAt?: Date;
  expertName?: string | null;
  service?: string | null;
  diagnosis?: string | null;
  prescription?: string | null;
  /**
   * Structured drug lines. When present and non-empty they become the visit's
   * prescription and the free text is ignored on read.
   *
   * `undefined` means 'leave the existing items alone' (a PATCH that does not
   * mention medicines); `[]` means 'clear them'. The two are NOT the same, and
   * conflating them silently wipes a script on an unrelated edit.
   */
  items?: RxItemLike[];
  advice?: string | null;
  followUpAt?: Date | null;
  internalNotes?: string | null;
  sharedWithContact?: boolean;
  /** Their id for this visit — makes a repeated push an update, not a duplicate. */
  externalId?: string | null;
};

export interface PatientDataProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  /**
   * The visits a patient may see: shared only, no internal notes, newest first.
   * The single query patient-facing code is allowed to use.
   */
  listPatientVisits(contactId: string, opts?: { take?: number }): Promise<VisitsResult>;

  /** Full history for staff, including internal notes. */
  listStaffVisits(contactId: string, opts?: { take?: number }): Promise<VisitsResult>;

  /** Record a consultation. Only valid when `canWriteRecords`. */
  createVisit(contactId: string, input: VisitInput): Promise<{ id: string } | { error: string }>;

  /** Fetch a document's bytes, scoped so one patient can't read another's. */
  readDocument(
    documentId: string,
    scope: { orgId: string; contactId?: string },
  ): Promise<{ name: string; mimeType: string; buffer: Buffer } | null>;
}
