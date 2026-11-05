import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { attachDocument, getPatientProvider } from '@/lib/patients';
import { dispatchPatientEvent } from '@/lib/webhooks';
import { parseRxItems } from '@/lib/patients/prescription';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// File a visit record against a patient — the doctor's post-consultation step,
// and the thing that gives the patient's chatbot something to answer from.
//
// Accepts multipart so the typed prescription and the scanned one arrive in a
// single request; a doctor should not have to save, then upload, then wait.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const contact = await prisma.contact.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // When the clinic's own system owns clinical records, refuse the write here.
  // The UI hides the form, but the endpoint has to hold the line too — a record
  // typed into us would be overwritten by their next sync, and the patient
  // would be reading whichever version happened to win.
  const provider = await getPatientProvider(ctx.org.id);
  if (!provider.capabilities.canWriteRecords) {
    return NextResponse.json(
      { error: `Records are managed in ${provider.capabilities.systemOfRecord}. Add the consultation there and it will appear here automatically.` },
      { status: 409 },
    );
  }

  const form = await req.formData();
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const date = (k: string) => {
    const v = str(k);
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // Parsed BEFORE the visit is created: a rejected medicine line must not leave
  // behind a half-written consultation with no prescription on it.
  const rx = parseRxItems(form.get('prescriptionItems'));
  if ('error' in rx) return NextResponse.json({ error: rx.error }, { status: 400 });

  const visit = await prisma.visitRecord.create({
    data: {
      orgId: ctx.org.id,
      workspaceId: ctx.workspace.id,
      contactId: contact.id,
      appointmentId: str('appointmentId'),
      visitedAt: date('visitedAt') ?? new Date(),
      expertName: str('expertName'),
      service: str('service'),
      diagnosis: str('diagnosis'),
      prescription: str('prescription'),
      advice: str('advice'),
      followUpAt: date('followUpAt'),
      internalNotes: str('internalNotes'),
      // Default to shared: the point of filing a record is that the patient can
      // read it. Staff opt out explicitly for a record they're not ready to
      // release.
      sharedWithContact: form.get('sharedWithContact') !== 'false',
      // Held by default: the doctor opts IN to releasing a diagnosis. The
      // prescription and advice still go out immediately — it is only the
      // diagnosis that waits for a conversation.
      diagnosisSharedAt: form.get('releaseDiagnosis') === 'true' ? new Date() : null,
      createdById: ctx.user.id,
      // Nested create keeps the script and the visit in one statement — there is
      // no window in which a consultation exists with its medicines missing.
      items: {
        create: rx.items.map((it, i) => ({ ...it, orgId: ctx.org.id, sortOrder: i })),
      },
    },
  });

  // Attachments are best-effort per file: one rejected scan shouldn't discard
  // the prescription the doctor just typed.
  const rejected: string[] = [];
  for (const entry of form.getAll('files')) {
    if (!(entry instanceof File) || entry.size === 0) continue;
    const res = await attachDocument({
      visitId: visit.id,
      orgId: ctx.org.id,
      name: entry.name,
      mimeType: entry.type || 'application/octet-stream',
      buffer: Buffer.from(await entry.arrayBuffer()),
    });
    if ('error' in res) rejected.push(`${entry.name}: ${res.error}`);
  }

  await audit(ctx, 'patient.visit_recorded', {
    targetType: 'VisitRecord',
    targetId: visit.id,
    metadata: { contactId: contact.id, shared: visit.sharedWithContact },
    req,
  });

  // Write-back, so a clinic running us as the record system can still mirror
  // consultations into their billing or analytics stack.
  void dispatchPatientEvent(ctx.workspace.id, 'visit.recorded', {
    visitId: visit.id,
    contactId: contact.id,
    externalId: null,
    visitedAt: visit.visitedAt.toISOString(),
    service: visit.service,
    expertName: visit.expertName,
  });

  return NextResponse.json({ id: visit.id, rejected }, { status: 201 });
}
