import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { parseRxItems } from '@/lib/patients/prescription';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function loadScoped(visitId: string, contactId: string, workspaceId: string) {
  return prisma.visitRecord.findFirst({ where: { id: visitId, contactId, workspaceId } });
}

// Edit a filed record — correcting a dosage typo, or releasing a record that was
// held back. Deliberately narrow: this is a medical record, so the editable
// surface is the clinical text and the share flag, nothing structural.
export async function PATCH(req: Request, props: { params: Promise<{ id: string; visitId: string }> }) {
  const { id, visitId } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const visit = await loadScoped(visitId, id, ctx.workspace.id);
  if (!visit) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const raw = (await req.json().catch(() => ({}))) as { action?: 'release-diagnosis' | 'withhold-diagnosis' };

  // Release is an ACTION, not a raw timestamp — matching the block-portal idiom
  // on /api/patients/[id]. A client can never backdate a release, and the audit
  // line means something.
  if (raw.action === 'release-diagnosis' || raw.action === 'withhold-diagnosis') {
    const releasing = raw.action === 'release-diagnosis';
    await prisma.visitRecord.update({
      where: { id: visit.id },
      data: { diagnosisSharedAt: releasing ? new Date() : null },
    });
    await audit(ctx, releasing ? 'patient.diagnosis_released' : 'patient.diagnosis_withheld', {
      targetType: 'VisitRecord',
      targetId: visit.id,
      req,
    });
    return NextResponse.json({ ok: true });
  }

  const body = raw as Partial<{
    diagnosis: string | null;
    prescription: string | null;
    prescriptionItems: unknown;
    advice: string | null;
    internalNotes: string | null;
    sharedWithContact: boolean;
  }>;

  // `undefined` means "this edit didn't touch the medicines"; `[]` means "clear
  // them". Collapsing the two would wipe a script whenever someone fixed a typo
  // in the advice field.
  let items: ReturnType<typeof parseRxItems> | null = null;
  if (body.prescriptionItems !== undefined) {
    items = parseRxItems(body.prescriptionItems);
    if ('error' in items) return NextResponse.json({ error: items.error }, { status: 400 });
  }

  await prisma.visitRecord.update({
    where: { id: visit.id },
    data: {
      ...(body.diagnosis !== undefined ? { diagnosis: body.diagnosis?.trim() || null } : {}),
      ...(body.prescription !== undefined ? { prescription: body.prescription?.trim() || null } : {}),
      ...(body.advice !== undefined ? { advice: body.advice?.trim() || null } : {}),
      ...(body.internalNotes !== undefined ? { internalNotes: body.internalNotes?.trim() || null } : {}),
      ...(typeof body.sharedWithContact === 'boolean' ? { sharedWithContact: body.sharedWithContact } : {}),
      // Replace wholesale rather than diff: a prescription is edited as a whole
      // script, and matching old rows to new ones by position or by drug name
      // would silently keep a line the doctor deleted.
      ...(items && !('error' in items)
        ? {
            items: {
              deleteMany: {},
              create: items.items.map((it, i) => ({ ...it, orgId: visit.orgId, sortOrder: i })),
            },
          }
        : {}),
    },
  });
  await audit(ctx, 'patient.visit_updated', { targetType: 'VisitRecord', targetId: visit.id, req });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, props: { params: Promise<{ id: string; visitId: string }> }) {
  const { id, visitId } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const visit = await loadScoped(visitId, id, ctx.workspace.id);
  if (!visit) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.visitRecord.delete({ where: { id: visit.id } });
  await audit(ctx, 'patient.visit_deleted', { targetType: 'VisitRecord', targetId: visit.id, req });
  return NextResponse.json({ ok: true });
}
