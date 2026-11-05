import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { uniqueWorkspaceSlug } from '@/lib/slug';
import { checkCreateAllowed, limitMessage } from '@/lib/billing/catalogue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// All organizations the caller belongs to, each with its workspaces, plus the
// active selection. Powers the workspace switcher.
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const memberships = await prisma.membership.findMany({
    where: { userId: ctx.user.id },
    include: { org: { include: { workspaces: { orderBy: { createdAt: 'asc' } } } } },
    orderBy: { createdAt: 'asc' },
  });

  const orgs = memberships.map((m) => ({
    id: m.org.id,
    name: m.org.name,
    role: m.role,
    workspaces: m.org.workspaces.map((w) => ({ id: w.id, name: w.name })),
  }));

  return NextResponse.json({
    orgs,
    activeOrgId: ctx.org.id,
    activeWorkspaceId: ctx.workspace.id,
  });
}

// Create a workspace in the active organization and switch to it.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'workspace:write');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

  const gate = await checkCreateAllowed(ctx.org.id, 'workspaces');
  if (!gate.allowed) {
    return NextResponse.json({ error: limitMessage('workspaces', gate.limit, gate.plan) }, { status: 403 });
  }

  const slug = await uniqueWorkspaceSlug(ctx.org.id, name);
  const ws = await prisma.workspace.create({
    data: { orgId: ctx.org.id, name, slug },
  });
  await prisma.user.update({
    where: { id: ctx.user.id },
    data: { activeOrgId: ctx.org.id, activeWorkspaceId: ws.id },
  });

  return NextResponse.json(ws, { status: 201 });
}
