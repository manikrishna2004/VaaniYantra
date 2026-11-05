import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'agent:write');
  if (denied) return denied;

  const portal = await prisma.portal.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!portal) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Partial<{
    name: string;
    greeting: string | null;
    agentId: string | null;
    enabled: boolean;
    allowRecords: boolean;
    allowBooking: boolean;
    allowDownloads: boolean;
  }>;

  // The slug is intentionally NOT editable: it is baked into every link already
  // messaged to a patient, and changing it would break all of them at once.
  if (body.agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: body.agentId, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    if (!agent) return NextResponse.json({ error: 'That agent does not exist.' }, { status: 400 });
  }

  const updated = await prisma.portal.update({
    where: { id: portal.id },
    data: {
      ...(body.name?.trim() ? { name: body.name.trim().slice(0, 80) } : {}),
      ...(body.greeting !== undefined ? { greeting: body.greeting?.trim().slice(0, 500) || null } : {}),
      ...(body.agentId !== undefined ? { agentId: body.agentId || null } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.allowRecords === 'boolean' ? { allowRecords: body.allowRecords } : {}),
      ...(typeof body.allowBooking === 'boolean' ? { allowBooking: body.allowBooking } : {}),
      ...(typeof body.allowDownloads === 'boolean' ? { allowDownloads: body.allowDownloads } : {}),
    },
  });

  await audit(ctx, 'portal.updated', { targetType: 'Portal', targetId: portal.id, req });
  return NextResponse.json(updated);
}

export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'agent:write');
  if (denied) return denied;

  const portal = await prisma.portal.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!portal) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.portal.delete({ where: { id: portal.id } });
  await audit(ctx, 'portal.deleted', { targetType: 'Portal', targetId: portal.id, metadata: { slug: portal.slug }, req });
  return NextResponse.json({ ok: true });
}
