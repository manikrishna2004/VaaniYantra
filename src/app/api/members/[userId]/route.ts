import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { isRole } from '@/lib/auth/permissions';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function ownerCount(orgId: string): Promise<number> {
  return prisma.membership.count({ where: { orgId, role: 'OWNER' } });
}

// Change a member's role.
export async function PATCH(req: Request, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { role?: string };
  if (!isRole(body.role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }
  // Only owners may grant the OWNER role.
  if (body.role === 'OWNER' && ctx.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only owners can assign the owner role' }, { status: 403 });
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: params.userId, orgId: ctx.org.id } },
  });
  if (!membership) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  // Don't allow demoting the last owner.
  if (membership.role === 'OWNER' && body.role !== 'OWNER' && (await ownerCount(ctx.org.id)) <= 1) {
    return NextResponse.json({ error: 'An organization must have at least one owner' }, { status: 400 });
  }
  // Only owners can modify an existing owner.
  if (membership.role === 'OWNER' && ctx.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only owners can modify an owner' }, { status: 403 });
  }

  const updated = await prisma.membership.update({
    where: { id: membership.id },
    data: { role: body.role },
  });
  await audit(ctx, 'member.role_changed', {
    targetType: 'User',
    targetId: params.userId,
    metadata: { from: membership.role, to: updated.role },
    req,
  });
  return NextResponse.json({ ok: true, role: updated.role });
}

// Remove a member from the organization.
export async function DELETE(req: Request, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: params.userId, orgId: ctx.org.id } },
  });
  if (!membership) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  if (membership.role === 'OWNER' && (await ownerCount(ctx.org.id)) <= 1) {
    return NextResponse.json({ error: 'Cannot remove the last owner' }, { status: 400 });
  }
  if (membership.role === 'OWNER' && ctx.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only owners can remove an owner' }, { status: 403 });
  }

  await prisma.membership.delete({ where: { id: membership.id } });
  // If the removed user had this org active, clear it so they fall back.
  await prisma.user.updateMany({
    where: { id: params.userId, activeOrgId: ctx.org.id },
    data: { activeOrgId: null, activeWorkspaceId: null },
  });
  await audit(ctx, 'member.removed', { targetType: 'User', targetId: params.userId, req });

  return NextResponse.json({ ok: true });
}
