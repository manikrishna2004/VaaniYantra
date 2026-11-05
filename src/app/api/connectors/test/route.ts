import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { sendWhatsApp } from '@/lib/connectors';
import { isValidPhoneNumber } from '@/lib/utils';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Send a real test message so the user can confirm a channel works without
// waiting for a live call.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { channel?: string; to?: string };
  const to = body.to?.trim();
  if (!to || !isValidPhoneNumber(to)) {
    return NextResponse.json({ error: 'Enter a destination number in E.164, e.g. +919876543210.' }, { status: 400 });
  }
  // WhatsApp is the only channel; `body.channel` is ignored rather than
  // rejected, so an older client that still posts {channel:'sms'} gets a
  // WhatsApp test instead of a confusing 400.
  const channel = 'whatsapp';
  const text = 'Test WhatsApp from your VaaniYantra connector. It works!';
  const ok = await sendWhatsApp(ctx.org.id, to, text);

  await audit(ctx, 'connector.test', { targetType: 'Integration', metadata: { channel, ok }, req });
  return ok
    ? NextResponse.json({ ok: true, message: `Test WhatsApp sent to ${to}.` })
    : NextResponse.json(
        { error: 'Could not send the WhatsApp message. Check your WhatsApp sender setup.' },
        { status: 502 },
      );
}
