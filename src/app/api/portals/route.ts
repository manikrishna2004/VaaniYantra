import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { slugify } from '@/lib/slug';
import { portalBaseUrl } from '@/lib/portal/contacts';
import { checkCreateAllowed, limitMessage } from '@/lib/billing/catalogue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Reserved so a chatbot slug can never shadow a real route on the same origin.
// /c/ is its own segment, but a clinic naming itself "api" or "admin" is the
// kind of thing that only bites once.
const RESERVED = new Set(['api', 'admin', 'new', 'sign-in', 'sign-up', 'c', 'docs', 'status']);

/** A globally unique public slug — the URL is global, so the slug must be. */
async function uniquePortalSlug(name: string): Promise<string> {
  const root = slugify(name);
  const base = RESERVED.has(root) ? `${root}-clinic` : root;
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i}`;
    if (!(await prisma.portal.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:read');
  if (denied) return denied;

  const portals = await prisma.portal.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: 'asc' },
    include: { agent: { select: { id: true, name: true } } },
  });
  return NextResponse.json({
    portals: portals.map((p) => ({ ...p, url: `${portalBaseUrl().replace(/\/+$/, '')}/c/${p.slug}` })),
  });
}

export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'agent:write');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { name?: string; agentId?: string };
  const name = (body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'Give your chatbot a name.' }, { status: 400 });

  // The chatbot is a billed product line, so creating one is plan-gated the
  // same way agents and workspaces are. A voice-only plan has a limit of 0.
  const quota = await checkCreateAllowed(ctx.org.id, 'chatbots');
  if (!quota.allowed) {
    return NextResponse.json({ error: limitMessage('chatbots', quota.limit, quota.plan) }, { status: 403 });
  }

  // Keep the agent binding inside the workspace, so a chatbot can never be
  // pointed at another tenant's knowledge base.
  let agentId: string | null = null;
  if (body.agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: body.agentId, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    if (!agent) return NextResponse.json({ error: 'That agent does not exist.' }, { status: 400 });
    agentId = agent.id;
  }

  const portal = await prisma.portal.create({
    data: {
      orgId: ctx.org.id,
      workspaceId: ctx.workspace.id,
      name: name.slice(0, 80),
      slug: await uniquePortalSlug(name),
      agentId,
      createdById: ctx.user.id,
    },
  });

  await audit(ctx, 'portal.created', { targetType: 'Portal', targetId: portal.id, metadata: { slug: portal.slug }, req });
  return NextResponse.json({ ...portal, url: `${portalBaseUrl().replace(/\/+$/, '')}/c/${portal.slug}` }, { status: 201 });
}
