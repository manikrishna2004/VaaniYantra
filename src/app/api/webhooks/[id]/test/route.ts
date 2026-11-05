import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { deliver, sampleCallPayload, isWebhookEvent } from '@/lib/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Send a sample payload to the webhook so the user can confirm their endpoint
// receives and verifies it. Returns the delivery outcome.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const webhook = await prisma.webhook.findFirst({
    where: { id: params.id, workspaceId: ctx.workspace.id },
  });
  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const event = isWebhookEvent(body?.event) ? body.event : webhook.events[0];
  const evt = isWebhookEvent(event) ? event : 'call.completed';

  const result = await deliver(webhook, sampleCallPayload(evt));
  return NextResponse.json(result);
}
