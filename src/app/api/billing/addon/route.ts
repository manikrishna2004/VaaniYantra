import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { getWhatsappChatAddonPrice } from '@/lib/platform';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Owner enables/disables the WhatsApp follow-up chat add-on. Flat monthly fee
// (billed via the monthly sweep). Can only be enabled once the founder has set
// a price in /admin. OWNER only.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { addon?: string; enabled?: boolean };
  if (body.addon !== 'whatsappChat') {
    return NextResponse.json({ error: 'Unknown add-on' }, { status: 400 });
  }
  const enabled = body.enabled === true;

  // While WhatsApp is feature-flagged off the add-on can't work — allow turning
  // it OFF (so nobody keeps getting billed) but not on.
  if (enabled && !whatsappEnabled()) {
    return NextResponse.json({ error: 'This add-on isn’t available.' }, { status: 404 });
  }

  if (enabled) {
    const price = await getWhatsappChatAddonPrice();
    if (price <= 0) {
      return NextResponse.json({ error: 'This add-on isn’t available yet.' }, { status: 400 });
    }
  }

  await prisma.organization.update({ where: { id: ctx.org.id }, data: { whatsappChatAddon: enabled } });
  await audit(ctx, 'billing.addon_changed', {
    targetType: 'Organization',
    targetId: ctx.org.id,
    metadata: { addon: 'whatsappChat', enabled },
    req,
  });
  return NextResponse.json({ ok: true, enabled });
}
