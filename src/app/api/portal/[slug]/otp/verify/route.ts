import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { verifyOtp, issueSelectionToken } from '@/lib/portal/otp';
import { householdByPhone } from '@/lib/patients/household';
import { createPortalLogin, touchContact } from '@/lib/portal/contacts';
import { PORTAL_COOKIE, portalCookieOptions } from '@/lib/portal/session';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// One generic message for every failure. A patient cannot act on the difference
// between "wrong code", "expired", and "we never sent one to that number", and
// spelling it out would tell a stranger which numbers are patients here.
const GENERIC = 'That code is not right, or it has expired. Ask for a new one.';

/** Check a code and, if it belongs to a patient here, sign them in. */
export async function POST(req: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;

  const ipLimit = checkRateLimit(`portal:otp:verify:${clientIp(req)}`, { limit: 30, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { phone?: string; code?: string };
  const phone = toE164(body.phone ?? '');
  const code = (body.code ?? '').trim();
  if (!phone || !/^\d{4,8}$/.test(code)) {
    return NextResponse.json({ error: GENERIC }, { status: 400 });
  }

  const portal = await prisma.portal.findUnique({ where: { slug } });
  if (!portal || !portal.enabled) {
    return NextResponse.json({ error: 'This chatbot is not available.' }, { status: 404 });
  }

  const result = await verifyOtp({ portalId: portal.id, phone, code });
  if (!result.ok) {
    return NextResponse.json({ error: GENERIC }, { status: 401 });
  }

  // The code was genuine. Whether it maps to a patient is a separate question:
  // /otp/start issues codes for unknown numbers too, so this is where an
  // unrecognised number lands — with the same `reason: 'anonymous'` the rest of
  // the portal already uses for "signed in as nobody".
  // A number can belong to a whole family, so the code alone does not identify
  // a patient — it identifies a HOUSEHOLD.
  const candidates = await householdByPhone(portal.orgId, phone);

  // More than one: hand back a short-lived selection token and let them choose.
  // No cookie is issued here, so nothing is signed in until a person is picked.
  //
  // First names only. Whoever holds the phone plus the code can already reach
  // this household — that is the trust boundary the product accepts — but there
  // is no reason to hand them patient numbers or dates of birth as well.
  if (candidates.length > 1) {
    const selectionToken = await issueSelectionToken(result.otpId);
    return NextResponse.json({
      ok: true,
      needsSelection: true,
      selectionToken,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name.split(' ')[0] })),
    });
  }

  const contact = candidates[0] ?? null;
  if (!contact) {
    return NextResponse.json(
      {
        error: 'We don’t have a record for this number. Please call the clinic and ask them to add you.',
        reason: 'anonymous',
      },
      { status: 401 },
    );
  }

  // Never auto-create a patient here. Doing so would let anyone with a phone
  // enrol themselves at any clinic and start burning its chat allowance.
  const token = await createPortalLogin({
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
    metadata: { portal: slug },
    ip: clientIp(req),
  });

  const res = NextResponse.json({ ok: true, name: contact.name });
  res.cookies.set(PORTAL_COOKIE, token, portalCookieOptions());
  return res;
}
