import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { startOtp } from '@/lib/portal/otp';
import { sendConfirmation } from '@/lib/connectors';
import { otpTemplate } from '@/lib/whatsapp-templates';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Send a patient a one-time code.
 *
 * DOES NOT REVEAL WHETHER THE NUMBER BELONGS TO A PATIENT. The response, the
 * status code and the work done are identical either way — a row is written
 * whichever it is, so /otp/verify has the same shape and timing to answer with
 * too. Only the SMS differs, and nobody but the number's owner can see that.
 * Without this, anyone could use the endpoint to ask "is this person a patient
 * at this clinic?", which is exactly the kind of thing a clinic must not leak.
 */
export async function POST(req: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;

  // Cheap first line only. The limits that actually bound an attack (attempts,
  // cooldown, per-hour cap) are in the database — see src/lib/portal/otp.ts.
  const ipLimit = checkRateLimit(`portal:otp:start:${clientIp(req)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { phone?: string };
  const phone = toE164(body.phone ?? '');
  if (!phone) {
    return NextResponse.json({ error: 'Enter your mobile number, including the country code.' }, { status: 400 });
  }

  const portal = await prisma.portal.findUnique({ where: { slug } });
  if (!portal || !portal.enabled) {
    return NextResponse.json({ error: 'This chatbot is not available.' }, { status: 404 });
  }

  const started = await startOtp({ portalId: portal.id, orgId: portal.orgId, phone });
  if (!started.ok) {
    return NextResponse.json(
      { error: 'A code was just sent. Please wait a moment before asking for another.' },
      { status: 429, headers: { 'Retry-After': String(started.retryAfterSec) } },
    );
  }

  // The portal slug scopes the tenant, so a number registered at three clinics
  // has three independent patient records and three independent codes.
  //
  // A number may now belong to a whole household, so this asks "is there ANY
  // unblocked patient here?" rather than "is there THE patient?". Blocking one
  // family member must not lock the rest of the family out.
  const contact = await prisma.contact.findFirst({
    where: { orgId: portal.orgId, phone, portalRevokedAt: null },
    select: { id: true },
  });

  // Send only to a real, unblocked patient. Everyone else gets the same reply
  // and no message — this branch is the entire difference, and it is invisible
  // from outside.
  if (contact && started.code) {
    const business = portal.name;
    void sendConfirmation(
      portal.orgId,
      phone,
      `${started.code} is your verification code for ${business}. It expires in 5 minutes. Do not share it with anyone.`,
      otpTemplate({ code: started.code, business }),
    );
    void writeAudit({
      orgId: portal.orgId,
      action: 'portal.otp_sent',
      targetType: 'Contact',
      targetId: contact.id,
      metadata: { portal: slug },
      ip: clientIp(req),
    });
  }

  return NextResponse.json({ ok: true });
}
