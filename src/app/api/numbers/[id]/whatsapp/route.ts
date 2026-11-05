import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { deny } from '@/lib/auth/api';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// Designate a connected Twilio/Exotel/Plivo number as the org's WhatsApp sender.
// Outbound WhatsApp then routes through this number's own provider account. The
// number must be WhatsApp-enabled at the provider first (Twilio/Exotel, or a
// Plivo WhatsApp Business number) — a provider-side step we can't do for them.
// One WhatsApp sender per org.
export async function POST(_req: Request, props: Params) {
  const params = await props.params;
  if (!whatsappEnabled()) return NextResponse.json({ error: 'WhatsApp is not available.' }, { status: 404 });
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const number = await prisma.phoneNumber.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: { workspace: { select: { orgId: true } } },
  });
  if (!number) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (number.provider !== 'twilio' && number.provider !== 'exotel' && number.provider !== 'plivo') {
    return NextResponse.json({ error: 'Only Twilio, Exotel or Plivo numbers can send WhatsApp.' }, { status: 400 });
  }

  const orgId = number.workspace.orgId;
  // Keep a single WhatsApp sender per org: clear any other, then set this one.
  await prisma.phoneNumber.updateMany({
    where: { workspace: { orgId }, whatsappEnabled: true, NOT: { id: number.id } },
    data: { whatsappEnabled: false },
  });
  await prisma.phoneNumber.update({ where: { id: number.id }, data: { whatsappEnabled: true } });
  return NextResponse.json({ ok: true, whatsappEnabled: true });
}

export async function DELETE(_req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const number = await prisma.phoneNumber.findFirst({ where: { id: params.id, workspaceId: workspace.id } });
  if (!number) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.phoneNumber.update({ where: { id: number.id }, data: { whatsappEnabled: false } });
  return NextResponse.json({ ok: true, whatsappEnabled: false });
}
