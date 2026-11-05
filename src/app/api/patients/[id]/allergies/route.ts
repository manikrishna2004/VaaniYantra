import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { ALLERGY_SEVERITIES } from '@/lib/patients/allergies';
import { getPatientProvider } from '@/lib/patients';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function loadScoped(id: string, workspaceId: string) {
  return prisma.contact.findFirst({ where: { id, workspaceId }, select: { id: true, orgId: true } });
}

/**
 * Record an allergy, or record that there are none.
 *
 * `action: 'none-known'` exists as its own path deliberately. If saying "I
 * asked, and there are none" required filling in a form, nobody would ever do
 * it and every patient would sit at "not recorded" forever — which makes the
 * three-state model theoretical rather than real. It has to be one click.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const contact = await loadScoped(id, ctx.workspace.id);
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // When the clinic's own system owns clinical records, an allergy typed here
  // would be silently overwritten by their next sync — so don't invite it.
  const provider = await getPatientProvider(ctx.org.id);
  if (!provider.capabilities.canWriteRecords) {
    return NextResponse.json(
      { error: `Allergies are managed in ${provider.capabilities.systemOfRecord}.` },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'none-known';
    substance?: string;
    reaction?: string;
    severity?: string;
  };

  if (body.action === 'none-known') {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { allergiesReviewedAt: new Date(), allergiesReviewedById: ctx.user.id },
    });
    await audit(ctx, 'patient.allergies_reviewed', { targetType: 'Contact', targetId: contact.id, req });
    return NextResponse.json({ ok: true });
  }

  const substance = (body.substance ?? '').trim();
  if (!substance) return NextResponse.json({ error: 'What are they allergic to?' }, { status: 400 });
  const severity = ALLERGY_SEVERITIES.find((s) => s.value === body.severity)?.value;
  if (!severity) {
    return NextResponse.json({ error: 'Pick a severity: mild, moderate or severe.' }, { status: 400 });
  }

  const allergy = await prisma.allergy.create({
    data: {
      orgId: contact.orgId,
      contactId: contact.id,
      substance: substance.slice(0, 120),
      reaction: (body.reaction ?? '').trim().slice(0, 200) || null,
      severity,
      recordedById: ctx.user.id,
    },
  });

  // Recording one is also a review — it means somebody asked.
  await prisma.contact.update({
    where: { id: contact.id },
    data: { allergiesReviewedAt: new Date(), allergiesReviewedById: ctx.user.id },
  });

  await audit(ctx, 'patient.allergy_recorded', {
    targetType: 'Contact',
    targetId: contact.id,
    metadata: { substance, severity },
    req,
  });
  return NextResponse.json({ id: allergy.id }, { status: 201 });
}

/**
 * Retire an allergy.
 *
 * Superseded, never deleted: "the patient says this was never true" is itself a
 * clinical fact, and destroying the row destroys the audit trail of what the
 * prescriber could see at the time.
 */
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const contact = await loadScoped(id, ctx.workspace.id);
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const allergyId = new URL(req.url).searchParams.get('allergyId') ?? '';
  const updated = await prisma.allergy.updateMany({
    where: { id: allergyId, contactId: contact.id, retiredAt: null },
    data: { retiredAt: new Date() },
  });
  if (updated.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await audit(ctx, 'patient.allergy_retired', {
    targetType: 'Contact',
    targetId: contact.id,
    metadata: { allergyId },
    req,
  });
  return NextResponse.json({ ok: true });
}
