import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { redeemSelectionToken } from '@/lib/portal/otp';
import { householdByPhone } from '@/lib/patients/household';
import { createPortalLogin, touchContact } from '@/lib/portal/contacts';
import { PORTAL_COOKIE, portalCookieOptions } from '@/lib/portal/session';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Pick which member of a household is signing in.
 *
 * Reached only when a verified phone number turned out to belong to several
 * patients — a mother and her children, say.
 *
 * THE AUTHORIZATION RULE, which is the whole file:
 * the selection token proves control of a PHONE NUMBER. The phone determines
 * the allowed set. So the `contactId` in the request body is never trusted —
 * it is only ever checked for membership of the set re-derived from the token's
 * own stored phone. A caller cannot name someone else's patient id and be
 * signed in as them.
 */
export async function POST(req: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;

  const limit = checkRateLimit(`portal:otp:select:${clientIp(req)}`, { limit: 30, windowMs: 10 * 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { selectionToken?: string; contactId?: string };
  const token = (body.selectionToken ?? '').trim();
  const contactId = (body.contactId ?? '').trim();
  if (!token || !contactId) {
    return NextResponse.json({ error: 'Please choose who this is for.' }, { status: 400 });
  }

  const portal = await prisma.portal.findUnique({ where: { slug } });
  if (!portal || !portal.enabled) {
    return NextResponse.json({ error: 'This chatbot is not available.' }, { status: 404 });
  }

  const redeemed = await redeemSelectionToken(portal.id, token);
  if (!redeemed) {
    return NextResponse.json({ error: 'That took too long. Please sign in again.' }, { status: 401 });
  }

  // Re-derived from the token's phone, never from the request.
  const candidates = await householdByPhone(portal.orgId, redeemed.phone);
  const contact = candidates.find((c) => c.id === contactId);
  if (!contact) {
    return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
  }

  const sessionToken = await createPortalLogin({
    portalId: portal.id,
    contactId: contact.id,
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });

  void touchContact(contact.id);
  void writeAudit({
    orgId: portal.orgId,
    action: 'portal.login',
    targetType: 'Contact',
    targetId: contact.id,
    metadata: { portal: slug, household: true },
    ip: clientIp(req),
  });

  const res = NextResponse.json({ ok: true, name: contact.name });
  res.cookies.set(PORTAL_COOKIE, sessionToken, portalCookieOptions());
  return res;
}
