import { NextResponse } from 'next/server';
import { findOrgIdByWhatsappFrom } from '@/lib/connectors';
import { handleInboundWhatsApp } from '@/lib/whatsapp-chat';
import { whatsappEnabled } from '@/lib/flags';
import { verifyTwilioRequest } from '@/lib/telephony-signature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Inbound WhatsApp for orgs using the Twilio "bring-your-own" sender. Point the
// Twilio WhatsApp sender's inbound webhook here. Twilio posts form-encoded
// (From = caller, To = the business's sender, Body = text). The reply is sent
// asynchronously by the chat handler via the Twilio API, so we return empty
// TwiML. Gated on the org's whatsappChatAddon inside the handler.
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const emptyTwiml = new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
  if (!form || !whatsappEnabled()) return emptyTwiml;
  if (!(await verifyTwilioRequest(req, form))) return new NextResponse('forbidden', { status: 403 });

  const from = String(form.get('From') ?? '');
  const to = String(form.get('To') ?? '');
  const bodyText = String(form.get('Body') ?? '');
  if (!from || !to || !bodyText.trim()) return emptyTwiml;

  const orgId = await findOrgIdByWhatsappFrom(to);
  if (orgId) {
    await handleInboundWhatsApp({ orgId, from, text: bodyText, toNumber: to }).catch((e) =>
      console.error('[wa-twilio] chat handler failed', e),
    );
  }
  return emptyTwiml;
}
