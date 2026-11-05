import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { deny } from '@/lib/auth/api';
import { ownsAll } from '@/lib/auth/tenant';
import { phoneNumberUpdateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// Update routing: assign an agent, rename, set caller-ID, forwarding, or toggle
// inbound handling.
export async function PATCH(req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const existing = await prisma.phoneNumber.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const parsed = phoneNumberUpdateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  // The number itself is scoped above, but agentId comes from the body. Left
  // unchecked a tenant could point their own number at another clinic's agent,
  // and telephony/twilio/voice builds the call from the number's agentId — so
  // the victim's persona and knowledge would answer the caller, with the
  // transcript landing in this workspace.
  if (d.agentId && !(await ownsAll(prisma.agent, workspace.id, [d.agentId]))) {
    return NextResponse.json({ error: 'That agent does not exist.' }, { status: 400 });
  }

  const number = await prisma.phoneNumber.update({
    where: { id: params.id },
    data: {
      ...(d.agentId !== undefined ? { agentId: d.agentId || null } : {}),
      ...(d.label !== undefined ? { label: d.label || null } : {}),
      ...(d.callerIdName !== undefined ? { callerIdName: d.callerIdName || null } : {}),
      ...(d.forwardTo !== undefined ? { forwardTo: d.forwardTo || null } : {}),
      ...(d.inboundEnabled !== undefined ? { inboundEnabled: d.inboundEnabled } : {}),
    },
  });
  return NextResponse.json(number);
}

export async function DELETE(_req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const existing = await prisma.phoneNumber.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.phoneNumber.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
