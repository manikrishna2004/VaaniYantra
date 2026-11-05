import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Revoke a pending invitation.
export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const invitation = await prisma.invitation.findUnique({ where: { id: params.id } });
  if (!invitation || invitation.orgId !== ctx.org.id) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: 'REVOKED' },
  });
  return NextResponse.json({ ok: true });
}
