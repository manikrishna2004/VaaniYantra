import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Revoke an API key.
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'apikey:manage');
  if (denied) return denied;

  const key = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!key || key.orgId !== ctx.org.id) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  }
  if (!key.revokedAt) {
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    await audit(ctx, 'apikey.revoked', { targetType: 'ApiKey', targetId: key.id, req });
  }
  return NextResponse.json({ ok: true });
}
