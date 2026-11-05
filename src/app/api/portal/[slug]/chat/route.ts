import { NextResponse } from 'next/server';
import { currentPortalSession } from '@/lib/portal/session';
import { handlePortalMessage, MAX_INBOUND_CHARS } from '@/lib/portal/chat';
import { touchContact } from '@/lib/portal/contacts';
import { checkRateLimit } from '@/lib/rate-limit';
import { checkChatAllowed } from '@/lib/billing/catalogue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// One patient message in, one answer out. Each request costs model calls and can
// touch a real calendar, so it is rate-limited per contact rather than per IP —
// a clinic and its patients often share one NAT address.
export async function POST(req: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const session = await currentPortalSession(slug);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const limit = checkRateLimit(`portal:chat:${session.contact.id}`, { limit: 30, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "You're sending messages very quickly — give me a moment." },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = (body.text ?? '').trim();
  if (!text) return NextResponse.json({ error: 'Say something first.' }, { status: 400 });
  if (text.length > MAX_INBOUND_CHARS) {
    return NextResponse.json({ error: 'That message is too long.' }, { status: 400 });
  }

  // The clinic's monthly conversation allowance. A patient already mid-chat is
  // never cut off — the check only bites on their first message of the month.
  //
  // The patient is told the assistant is unavailable, and nothing more. They
  // are not the customer, they have no way to act on a quota, and a medical
  // chatbot announcing a billing problem to a patient is not acceptable. The
  // real reason is logged for the clinic.
  const quota = await checkChatAllowed(session.contact.orgId, session.contact.id);
  if (!quota.allowed) {
    console.warn(
      `[portal] chat quota reached for org ${session.contact.orgId}: ${quota.used}/${quota.limit} on ${quota.plan.name}`,
    );
    return NextResponse.json(
      {
        reply:
          "I'm not available right now, sorry. Please call the clinic directly and they'll be able to help you.",
        mutated: false,
      },
      { status: 200 },
    );
  }

  const result = await handlePortalMessage({ portal: session.portal, contact: session.contact, text });
  void touchContact(session.contact.id);
  return NextResponse.json(result);
}
