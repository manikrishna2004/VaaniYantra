import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { getWhatsappCloudConfig } from '@/lib/connectors';
import { getMetaConfig, fetchTemplateStatuses, provisionTemplates } from '@/lib/whatsapp-cloud';
import { WA_TEMPLATE_DEFINITIONS } from '@/lib/whatsapp-templates';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Review status of the message templates in a connected org's own WABA.
//
// Meta reviews each template after we create it (usually minutes for Utility,
// occasionally hours). Until one is APPROVED its proactive messages fall back to
// the shared sender or SMS, so a clinic that just connected needs to be able to
// see *why* its confirmations aren't coming from its own number yet. Without
// this the wait is indistinguishable from a broken connection.
export async function GET() {
  if (!whatsappEnabled()) return NextResponse.json({ error: 'WhatsApp is not available.' }, { status: 404 });
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:read');
  if (denied) return denied;

  const own = await getWhatsappCloudConfig(ctx.org.id);
  if (!own?.accessToken) return NextResponse.json({ connected: false, templates: [] });

  const meta = await getMetaConfig();
  const live = await fetchTemplateStatuses(meta, own.accessToken, own.wabaId);
  const byName = new Map(live.map((t) => [t.name, t]));

  // Report against what we EXPECT to exist, not just what Meta returns — a
  // template that failed to create is absent from Meta's list entirely, and
  // reporting only Meta's list would silently omit exactly the broken one.
  const templates = WA_TEMPLATE_DEFINITIONS.map((def) => ({
    name: def.name,
    status: byName.get(def.name)?.status ?? 'MISSING',
  }));

  return NextResponse.json({
    connected: true,
    displayPhone: own.displayPhone ?? null,
    verifiedName: own.verifiedName ?? null,
    templates,
    allApproved: templates.every((t) => t.status === 'APPROVED'),
  });
}

// Re-run provisioning. For templates that failed to create at connect time, or
// were rejected and since fixed — creating one that already exists is treated as
// success, so this is safe to press repeatedly.
export async function POST(req: Request) {
  if (!whatsappEnabled()) return NextResponse.json({ error: 'WhatsApp is not available.' }, { status: 404 });
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const own = await getWhatsappCloudConfig(ctx.org.id);
  if (!own?.accessToken) {
    return NextResponse.json({ error: 'Connect a WhatsApp number first.' }, { status: 400 });
  }

  const meta = await getMetaConfig();
  const result = await provisionTemplates(meta, own.accessToken, own.wabaId);
  await audit(ctx, 'connector.whatsapp_templates_provisioned', {
    targetType: 'Integration',
    metadata: { wabaId: own.wabaId, created: result.created, failed: result.failed.length },
    req,
  });
  return NextResponse.json({ ok: true, ...result });
}
