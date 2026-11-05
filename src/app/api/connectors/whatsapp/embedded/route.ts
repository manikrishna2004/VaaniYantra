import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { setWhatsappCloudConfig, disconnectWhatsappCloud, getWhatsappCloudConfig } from '@/lib/connectors';
import {
  getMetaConfig,
  isMetaConfigured,
  exchangeCode,
  subscribeApp,
  registerNumber,
  fetchNumberInfo,
  provisionTemplates,
} from '@/lib/whatsapp-cloud';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Complete WhatsApp Embedded Signup so a clinic can send from its OWN number.
//
// The browser SDK returns an auth `code` plus the WABA id and phone-number id
// the customer picked. We exchange the code for a business-scoped token,
// subscribe our app to their WABA so their inbound messages reach our webhook,
// register the number for Cloud API sending, and create our message templates
// in their (empty) WABA. The customer never leaves the platform.
//
// Requires VaaniYantra to be a Meta Tech Provider — verified 2026-08-09.
export async function POST(req: Request) {
  if (!whatsappEnabled()) return NextResponse.json({ error: 'WhatsApp is not available.' }, { status: 404 });
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { code?: string; wabaId?: string; phoneNumberId?: string };
  const code = body.code?.trim();
  const wabaId = body.wabaId?.trim();
  const phoneNumberId = body.phoneNumberId?.trim();
  if (!code || !wabaId || !phoneNumberId) {
    return NextResponse.json({ error: 'Missing WhatsApp signup details. Please try connecting again.' }, { status: 400 });
  }

  const meta = await getMetaConfig();
  if (!isMetaConfigured(meta)) {
    return NextResponse.json({ error: 'WhatsApp isn’t set up on the server yet.' }, { status: 400 });
  }

  try {
    const accessToken = await exchangeCode(meta, code);

    // Webhook subscription is fatal if it fails: without it the number can send
    // but nothing inbound ever arrives, which looks like a working connection
    // and is not one.
    await subscribeApp(meta, accessToken, wabaId);

    // Registration is best-effort — Embedded Signup usually registers the number
    // already, and a second attempt on an registered number is a harmless error.
    await registerNumber(meta, accessToken, phoneNumberId).catch(() => {});

    const info = await fetchNumberInfo(meta, accessToken, phoneNumberId).catch(
      () => ({}) as { verifiedName?: string; displayPhone?: string },
    );

    await setWhatsappCloudConfig(ctx.org.id, ctx.user.id, {
      wabaId,
      phoneNumberId,
      accessToken,
      verifiedName: info.verifiedName,
      displayPhone: info.displayPhone,
    });

    // Create our templates in their WABA. Deliberately AFTER the config is
    // stored and never fatal: a connected number whose templates are still in
    // review is a working number (inbound chat and 24h-window replies both
    // work, proactive messages fall back as they always have). Losing the
    // connection over a template error would be the worse outcome.
    const templates = await provisionTemplates(meta, accessToken, wabaId).catch(() => ({
      created: 0,
      failed: [{ name: 'all', reason: 'provisioning request failed' }],
    }));

    await audit(ctx, 'connector.whatsapp_cloud_connected', {
      targetType: 'Integration',
      metadata: { wabaId, phoneNumberId, templatesCreated: templates.created, templatesFailed: templates.failed.length },
      req,
    });

    return NextResponse.json({
      ok: true,
      verifiedName: info.verifiedName ?? null,
      displayPhone: info.displayPhone ?? null,
      templates,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not connect WhatsApp.' }, { status: 502 });
  }
}

// Disconnect the org's own-brand number. Its WhatsApp keeps working — messages
// simply go back to the shared platform sender, which is what every org that
// never connected a number uses.
export async function DELETE(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const existing = await getWhatsappCloudConfig(ctx.org.id);
  await disconnectWhatsappCloud(ctx.org.id);
  await audit(ctx, 'connector.whatsapp_cloud_removed', {
    targetType: 'Integration',
    metadata: existing ? { wabaId: existing.wabaId, phoneNumberId: existing.phoneNumberId } : undefined,
    req,
  });
  return NextResponse.json({ ok: true });
}
