import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { getMetaConfig, fetchTemplateStatuses, provisionTemplates } from '@/lib/whatsapp-cloud';
import { WA_TEMPLATE_DEFINITIONS } from '@/lib/whatsapp-templates';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Message templates in the PLATFORM's own WABA — the shared sender every org
// falls back to when it has no own-brand number.
//
// Why this exists next to the per-org route: that one provisions a customer's
// WABA at Embedded Signup, and nothing ever provisioned ours. So a template
// added to WA_TEMPLATE_DEFINITIONS reached every new customer automatically and
// the shared sender never at all — which is exactly how the platform ended up
// sending `appointment_confirmation_portal` to a WABA that had never been told
// the template exists, logging `(#132001) template name does not exist` on
// every booking and dropping each one to SMS.
//
// Super-admin only: this writes to the platform's Meta account, not a tenant's.

async function platformWaba() {
  const meta = await getMetaConfig();
  if (!meta.wabaId || !meta.systemUserToken) return null;
  return { meta, wabaId: meta.wabaId, token: meta.systemUserToken };
}

async function authorize() {
  if (!whatsappEnabled()) {
    return { error: NextResponse.json({ error: 'WhatsApp is not available.' }, { status: 404 }) };
  }
  const { ctx, error } = await apiContext();
  if (error) return { error };
  if (!isSuperAdmin(ctx.user.email)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ctx };
}

// Which templates the platform WABA actually has, and their review status.
// Reported against WA_TEMPLATE_DEFINITIONS rather than Meta's list, because a
// template that was never created is absent from Meta's list entirely — and
// that is precisely the one worth seeing.
export async function GET() {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await authorize();
  if (auth.error) return auth.error;

  const platform = await platformWaba();
  if (!platform) {
    return NextResponse.json({
      configured: false,
      error: 'No platform WABA id / system-user token configured.',
      templates: [],
    });
  }

  const live = await fetchTemplateStatuses(platform.meta, platform.token, platform.wabaId);
  const byName = new Map(live.map((t) => [t.name, t]));
  const templates = WA_TEMPLATE_DEFINITIONS.map((def) => ({
    name: def.name,
    status: byName.get(def.name)?.status ?? 'MISSING',
  }));

  return NextResponse.json({
    configured: true,
    wabaId: platform.wabaId,
    templates,
    allApproved: templates.every((t) => t.status === 'APPROVED'),
  });
}

// Create every provisionable template in the platform WABA. Creating one that
// already exists counts as success, so this is safe to re-run — which is how a
// newly added definition gets rolled out.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await authorize();
  if (auth.error) return auth.error;

  const platform = await platformWaba();
  if (!platform) {
    return NextResponse.json(
      { error: 'Set the platform WABA id and system-user token first.' },
      { status: 400 },
    );
  }

  const result = await provisionTemplates(platform.meta, platform.token, platform.wabaId);
  await audit(auth.ctx!, 'platform.whatsapp_templates_provisioned', {
    targetType: 'Platform',
    metadata: { wabaId: platform.wabaId, created: result.created, failed: result.failed.length },
    req,
  });
  return NextResponse.json({ ok: true, ...result });
}
