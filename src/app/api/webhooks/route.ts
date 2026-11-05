import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { webhookCreateSchema } from '@/lib/validation';
import { generateWebhookSecret } from '@/lib/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:read');
  if (denied) return denied;

  const webhooks = await prisma.webhook.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(webhooks);
}

export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const json = await req.json().catch(() => ({}));
  const parsed = webhookCreateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const webhook = await prisma.webhook.create({
    data: {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      type: d.type ?? 'generic',
      url: d.url,
      description: d.description ?? null,
      events: d.events,
      enabled: d.enabled ?? true,
      secret: generateWebhookSecret(),
    },
  });

  await audit(ctx, 'webhook.created', {
    targetType: 'Webhook',
    targetId: webhook.id,
    metadata: { url: webhook.url, events: webhook.events },
    req,
  });

  return NextResponse.json(webhook, { status: 201 });
}
