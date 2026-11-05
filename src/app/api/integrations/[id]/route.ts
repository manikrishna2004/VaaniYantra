import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

// Enable/disable a credential without deleting it.
export async function PATCH(req: Request, props: Params) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const existing = await prisma.integration.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  const row = await prisma.integration.update({
    where: { id: params.id },
    data: { ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}) },
  });
  return NextResponse.json({ id: row.id, enabled: row.enabled });
}

export async function DELETE(req: Request, props: Params) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const existing = await prisma.integration.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.integration.delete({ where: { id: params.id } });
  await audit(ctx, 'integration.removed', {
    targetType: 'Integration',
    targetId: params.id,
    metadata: { provider: existing.provider },
    req,
  });
  return NextResponse.json({ ok: true });
}
