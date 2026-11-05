import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { deny } from '@/lib/auth/api';
import { isMockTelephony } from '@/lib/adapters/telephony';
import { providerForNumber } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// Point the provider's inbound voice webhook for this number at our voice-server
// so calls to it are handled by the platform.
export async function POST(_req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const number = await prisma.phoneNumber.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
  });
  if (!number) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!number.providerSid) {
    return NextResponse.json({ error: 'Number has no provider SID to configure' }, { status: 400 });
  }

  const base =
    process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
  const wsHost = base.replace(/^https?:\/\//, '');

  // Exotel (and any provider that doesn't fetch a per-call answer webhook) can't
  // be configured via API — inbound routing is attached in the Exotel dashboard.
  // Surface the exact manual step instead of a scary 502, and don't mark it
  // configured (it isn't, until the user wires the applet).
  const provider = await providerForNumber(number);
  if (!provider.usesAnswerWebhook) {
    return NextResponse.json({
      ok: true,
      manual: true,
      instruction:
        `In the Exotel dashboard, attach a Voicebot-applet App to ${number.e164} ` +
        `and set its WebSocket URL to wss://${wsHost}/exotel`,
    });
  }

  // A number owned by a connected customer account is always real (Twilio/Plivo),
  // even when the server env runs in mock mode.
  if (!number.twilioAccountId && !number.plivoAccountId && isMockTelephony()) {
    await prisma.phoneNumber.update({ where: { id: number.id }, data: { webhookConfigured: true } });
    return NextResponse.json({ ok: true, mock: true });
  }
  // Plivo posts its own answer/status document format, so it gets its own path.
  const seg = provider.name === 'plivo' ? 'plivo' : 'twilio';
  try {
    await provider.configureNumberWebhook(number.providerSid, {
      voiceUrl: `${base}/api/telephony/${seg}/voice`,
      statusUrl: `${base}/api/telephony/${seg}/status`,
    });
    await prisma.phoneNumber.update({ where: { id: number.id }, data: { webhookConfigured: true } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Failed to configure webhook' }, { status: 502 });
  }
}
