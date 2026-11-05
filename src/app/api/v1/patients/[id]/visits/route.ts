import { NextResponse } from 'next/server';
import { parseRxItems } from '@/lib/patients/prescription';
import { prisma } from '@/lib/db';
import { requireApiAuth } from '@/lib/api/v1';
import { attachDocument } from '@/lib/patients';
import { dispatchPatientEvent } from '@/lib/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Public v1: the clinic's system pushes a consultation — what was prescribed,
// diagnosed and advised — for a patient it already created.
//
// `id` accepts either our contact id or their own `externalId`, so an
// integrator never has to store our identifiers to use this. Idempotent on the
// visit's `externalId` for the same reason the patient endpoint is: a replay
// after an outage must not double up someone's prescriptions.
//
// Attachments come as base64 in the same request rather than a second upload
// round-trip, because the systems pushing here are usually batch jobs, not
// interactive clients.

const MAX_ATTACHMENTS = 6;

type VisitBody = {
  externalId?: string;
  visitedAt?: string;
  expertName?: string;
  service?: string;
  diagnosis?: string;
  prescription?: string;
  /**
   * Structured drug lines. When present these BECOME the prescription and
   * `prescription` is ignored on every read surface — see renderPrescription().
   * Send both if your system prints prose too; only these will be shown.
   */
  medicines?: unknown[];
  advice?: string;
  followUpAt?: string;
  internalNotes?: string;
  sharedWithContact?: boolean;
  /** Defaults to true — see the note where it is applied. */
  diagnosisShared?: boolean;
  attachments?: { name?: string; mimeType?: string; contentBase64?: string }[];
};

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const auth = await requireApiAuth(req, 'patients:write');
  if (auth instanceof NextResponse) return auth;

  // Accept our id or theirs — whichever the integrator happens to hold.
  const contact = await prisma.contact.findFirst({
    where: { orgId: auth.orgId, OR: [{ id }, { externalId: id }] },
    select: { id: true, orgId: true, workspaceId: true },
  });
  if (!contact) return NextResponse.json({ error: 'Patient not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as VisitBody | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  // Parsed up front: a bad medicine line must not create a half-written visit.
  const rx = parseRxItems(body.medicines ?? []);
  if ('error' in rx) return NextResponse.json({ error: rx.error }, { status: 400 });

  const hasClinicalContent = !!(
    rx.items.length ||
    body.prescription ||
    body.diagnosis ||
    body.advice ||
    body.attachments?.length
  );
  if (!hasClinicalContent) {
    return NextResponse.json(
      { error: 'Provide at least one of: medicines, prescription, diagnosis, advice, attachments' },
      { status: 400 },
    );
  }
  if ((body.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
    return NextResponse.json({ error: `At most ${MAX_ATTACHMENTS} attachments per visit` }, { status: 400 });
  }

  const externalId = body.externalId?.trim() || null;
  const data = {
    orgId: contact.orgId,
    workspaceId: contact.workspaceId,
    contactId: contact.id,
    visitedAt: parseDate(body.visitedAt) ?? new Date(),
    expertName: body.expertName?.trim() || null,
    service: body.service?.trim() || null,
    diagnosis: body.diagnosis?.trim() || null,
    prescription: body.prescription?.trim() || null,
    advice: body.advice?.trim() || null,
    followUpAt: parseDate(body.followUpAt),
    internalNotes: body.internalNotes?.trim() || null,
    sharedWithContact: body.sharedWithContact !== false,
    // Released by DEFAULT here, unlike the in-app form — and the asymmetry is
    // deliberate. A push clinic's own system is the system of record and has
    // already decided what the patient may see; defaulting to withheld would,
    // on the day this ships, silently retract the diagnosis from every patient
    // of every integrated clinic. Pass diagnosisShared:false to hold one.
    diagnosisSharedAt:
      body.diagnosisShared === false ? null : parseDate(body.visitedAt) ?? new Date(),
    externalId,
    // Stamped so the staff UI knows this record belongs to their system and
    // must not be edited here.
    source: 'push',
  };

  const existing = externalId
    ? await prisma.visitRecord.findFirst({ where: { orgId: auth.orgId, externalId }, select: { id: true } })
    : null;

  // Replaced wholesale on an update, exactly like attachments below: a
  // corrected push must not leave a withdrawn medicine on the record.
  //
  // `medicines` omitted entirely means 'do not touch them', so a system that
  // pushes only a diagnosis correction cannot wipe the script.
  const items =
    body.medicines === undefined
      ? {}
      : {
          items: {
            deleteMany: {},
            create: rx.items.map((it, i) => ({ ...it, orgId: contact.orgId, sortOrder: i })),
          },
        };

  const visit = existing
    ? await prisma.visitRecord.update({ where: { id: existing.id }, data: { ...data, ...items }, select: { id: true } })
    : await prisma.visitRecord.create({ data: { ...data, ...items }, select: { id: true } });

  // Replace attachments wholesale on an update, so a corrected push doesn't
  // leave the superseded scan sitting alongside the new one.
  const rejected: string[] = [];
  if (body.attachments?.length) {
    if (existing) await prisma.visitDocument.deleteMany({ where: { visitId: visit.id } });
    for (const att of body.attachments) {
      if (!att?.contentBase64) continue;
      let buffer: Buffer;
      try {
        buffer = Buffer.from(att.contentBase64, 'base64');
      } catch {
        rejected.push(`${att.name ?? 'attachment'}: not valid base64`);
        continue;
      }
      const res = await attachDocument({
        visitId: visit.id,
        orgId: contact.orgId,
        name: att.name || 'document',
        mimeType: att.mimeType || 'application/pdf',
        buffer,
      });
      if ('error' in res) rejected.push(`${att.name ?? 'attachment'}: ${res.error}`);
    }
  }

  // Let the clinic's other systems know too (their CRM, their analytics) —
  // whoever pushed this may not be the only thing that cares.
  void dispatchPatientEvent(contact.workspaceId, 'visit.recorded', {
    visitId: visit.id,
    contactId: contact.id,
    externalId,
    visitedAt: data.visitedAt.toISOString(),
    service: data.service,
    expertName: data.expertName,
  });

  return NextResponse.json(
    { id: visit.id, externalId, created: !existing, rejectedAttachments: rejected },
    { status: existing ? 200 : 201 },
  );
}

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const auth = await requireApiAuth(req, 'patients:read');
  if (auth instanceof NextResponse) return auth;

  const contact = await prisma.contact.findFirst({
    where: { orgId: auth.orgId, OR: [{ id }, { externalId: id }] },
    select: { id: true },
  });
  if (!contact) return NextResponse.json({ error: 'Patient not found' }, { status: 404 });

  const visits = await prisma.visitRecord.findMany({
    where: { contactId: contact.id },
    orderBy: { visitedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      externalId: true,
      visitedAt: true,
      expertName: true,
      service: true,
      diagnosis: true,
      prescription: true,
      // Returned alongside the free text rather than instead of it, because an
      // integrator syncing back needs to see exactly what we hold. Which of the
      // two a PATIENT sees is decided by renderPrescription(), and `medicines`
      // wins whenever it is non-empty.
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
      advice: true,
      followUpAt: true,
      sharedWithContact: true,
      source: true,
      documents: { select: { id: true, name: true, mimeType: true, sizeBytes: true } },
    },
  });
  // `items` is renamed to `medicines` on the wire so the request and response
  // shapes match — an integrator can round-trip what they read.
  return NextResponse.json({
    data: visits.map(({ items, ...v }) => ({ ...v, medicines: items })),
  });
}
