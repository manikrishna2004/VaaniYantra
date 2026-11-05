import { NextResponse } from 'next/server';
import { getMetaConfig, verifyMetaSignature } from '@/lib/whatsapp-cloud';
import { resolveInboundWhatsappOrg } from '@/lib/connectors';
import { handleInboundWhatsApp } from '@/lib/whatsapp-chat';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Meta WhatsApp Cloud API webhook. GET answers the subscription verification
// challenge; POST receives inbound messages + delivery statuses (authenticity =
// the X-Hub-Signature-256 HMAC over the raw body, using the app secret).
export async function GET(req: Request) {
  if (!whatsappEnabled()) return new NextResponse('not found', { status: 404 });
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const meta = await getMetaConfig();
  if (mode === 'subscribe' && token && meta.verifyToken && token === meta.verifyToken) {
    return new NextResponse(challenge ?? '', { status: 200 });
  }
  return new NextResponse('forbidden', { status: 403 });
}

export async function POST(req: Request) {
  // Feature-flagged off: acknowledge (so Meta doesn't disable the subscription)
  // but process nothing.
  if (!whatsappEnabled()) return NextResponse.json({ received: true });
  const meta = await getMetaConfig();
  const raw = await req.text();
  // Fail closed. Guarding this on `meta.appSecret &&` meant an install with no
  // secret configured accepted every POST — and this handler resolves an org,
  // spends model tokens on a reply and sends a WhatsApp message back out, so an
  // unverified request is not a harmless one. If we cannot prove the request
  // came from Meta, we do not act on it.
  if (!meta.appSecret) {
    console.error('[wa-cloud] refusing webhook: no app secret configured, cannot verify authenticity');
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }
  if (!verifyMetaSignature(meta.appSecret, raw, req.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  try {
    const body = JSON.parse(raw);
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
        // Inbound customer text opens the 24h window — route it to the paid
        // follow-up chat add-on (no-op if the org hasn't enabled it).
        for (const msg of value.messages ?? []) {
          if (msg.type !== 'text' || !phoneNumberId) continue;
          const route = await resolveInboundWhatsappOrg({ phoneNumberId, from: msg.from });
          if (!route.orgId) {
            // Log every drop with its reason. An inbound message that resolves
            // to nobody used to vanish without trace, which is how routing
            // stayed broken in production for nine days.
            console.warn(
              `[wa-cloud] inbound dropped (${route.reason}) from=${msg.from} phoneNumberId=${phoneNumberId}`,
            );
            continue;
          }
          console.log(`[wa-cloud] inbound routed to org ${route.orgId} (${route.reason})`);
          await handleInboundWhatsApp({ orgId: route.orgId, from: msg.from, text: msg.text?.body ?? '' }).catch(
            (e) => console.error('[wa-cloud] chat handler failed', e),
          );
        }
        for (const status of value.statuses ?? []) {
          if (status.status === 'failed') {
            console.error('[wa-cloud] delivery failed', status.id, JSON.stringify(status.errors ?? []));
          }
        }
      }
    }
  } catch (err) {
    console.error('[wa-cloud] webhook parse failed', err);
  }
  // Always 200 so Meta doesn't disable the subscription on a transient error.
  return NextResponse.json({ received: true });
}
