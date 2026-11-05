import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { webhookUpdateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function load(workspaceId: string, id: string) {
  return prisma.webhook.findFirst({ where: { id, workspaceId } });
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:read');
  if (denied) return denied;

  const webhook = await load(ctx.workspace.id, params.id);
  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(webhook);
}

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const webhook = await load(ctx.workspace.id, params.id);
  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = webhookUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const updated = await prisma.webhook.update({
    where: { id: webhook.id },
    data: {
      ...(d.url !== undefined ? { url: d.url } : {}),
      ...(d.description !== undefined ? { description: d.description ?? null } : {}),
      ...(d.events !== undefined ? { events: d.events } : {}),
      ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
    },
  });

  await audit(ctx, 'webhook.updated', { targetType: 'Webhook', targetId: webhook.id, req });
  return NextResponse.json(updated);
}

export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const webhook = await load(ctx.workspace.id, params.id);
  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.webhook.delete({ where: { id: webhook.id } });
  await audit(ctx, 'webhook.deleted', {
    targetType: 'Webhook',
    targetId: webhook.id,
    metadata: { url: webhook.url },
    req,
  });
  return NextResponse.json({ ok: true });
}
