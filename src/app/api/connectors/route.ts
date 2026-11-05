import { NextResponse } from 'next/server';
import { apiContext } from '@/lib/auth/api';
import { getConnectorStatus } from '@/lib/connectors';
import { googleOAuthConfigured } from '@/lib/google-oauth';
import { getCalendarConfigFor } from '@/lib/calendar';
import { hasPermission } from '@/lib/auth/permissions';
import { getMetaConfig, isMetaConfigured } from '@/lib/whatsapp-cloud';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The connectors a clinic configures itself: Google Calendar, HubSpot CRM, and
// optionally its own WhatsApp number via Meta Embedded Signup. SMS is not here.
//
// WhatsApp is optional, not required: every org sends over the platform's own
// verified sender by default. Connecting a number swaps in the clinic's brand.
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;

  // Not gated on integration:read any more: a doctor without admin rights still
  // needs this page to connect their OWN calendar. The clinic-wide status is
  // gated instead, so they see their own card and nothing else.
  const canReadOrg = hasPermission(ctx.role, 'integration:read');

  const [status, mine, meta] = await Promise.all([
    canReadOrg ? getConnectorStatus(ctx.org.id) : Promise.resolve(null),
    getCalendarConfigFor(ctx.org.id, ctx.user.id),
    whatsappEnabled() ? getMetaConfig() : Promise.resolve(null),
  ]);

  return NextResponse.json({
    googleOAuthConfigured: googleOAuthConfigured(),
    canReadOrg,
    canManageOrg: hasPermission(ctx.role, 'integration:manage'),
    google: status?.google ?? { connected: false, email: null, calendarId: null },
    hubspot: status?.hubspot ?? { connected: false },
    // Own-brand WhatsApp. `available` gates the whole card: Embedded Signup
    // needs the platform's Meta app id + config id on file, and the browser SDK
    // needs both, so there is nothing to show without them.
    whatsapp: {
      available: Boolean(meta && isMetaConfigured(meta)),
      appId: meta?.appId ?? null,
      configId: meta?.configId ?? null,
      graphVersion: meta?.graphVersion ?? null,
      ...(status?.whatsappCloud ?? { connected: false, verifiedName: null, displayPhone: null }),
    },
    // The signed-in user's own calendar connection.
    myCalendar: { connected: Boolean(mine), email: mine?.email ?? null, calendarId: mine?.calendarId ?? null },
  });
}
