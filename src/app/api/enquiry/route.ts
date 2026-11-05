import { NextResponse } from 'next/server';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { sendMail, enquiryAckEmail, enquiryNotificationEmail, mailFrom } from '@/lib/mailer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// "Tell us what you need" — the public integration enquiry.
//
// This is what the walkthrough booker became. The booker put a slot on our
// calendar before anyone had told us anything; this asks the questions the
// first half of that meeting was spent on, so the conversation that follows can
// start at the useful part.
//
// UNAUTHENTICATED BY DESIGN: sign-up is invite-only, so this form is the ONLY
// way in for someone who does not have an account yet. That makes the rate
// limit load-bearing rather than decorative — every POST sends two real emails.

const LIMIT = { limit: 5, windowMs: 60 * 60_000 };

/** Where enquiries land. Overridable so it can be pointed at a shared inbox. */
function enquiryInbox(): string {
  return process.env.ENQUIRY_TO || 'info@vaaniyantra.com';
}

const trim = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = checkRateLimit(`enquiry:${ip}`, LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'That is a lot of enquiries from one place. Email info@vaaniyantra.com and we will sort it out.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  // Capped rather than merely trimmed: these strings go straight into an email
  // body, and an unbounded paste is how a form like this becomes a way to mail
  // a novel to our own inbox.
  const name = trim(b.name, 120);
  const email = trim(b.email, 200);
  const phone = trim(b.phone, 40);
  const orgName = trim(b.orgName, 160);
  const callsPerDay = trim(b.callsPerDay, 40);
  const requirements = trim(b.requirements, 4000);

  // Deliberately loose: an address either routes or it does not, and a strict
  // regex mostly rejects real people. The acknowledgement mail is the real test.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter a valid work email.' }, { status: 400 });
  }
  if (!orgName) {
    return NextResponse.json({ error: 'Tell us your clinic or hospital name.' }, { status: 400 });
  }
  if (requirements.length < 10) {
    return NextResponse.json(
      { error: 'Tell us a little about what you need — a couple of sentences is plenty.' },
      { status: 400 },
    );
  }

  // Ours first, and awaited: if this one fails the enquiry is lost, so the
  // visitor must not be told "we have it" when nobody has it. The
  // acknowledgement to them is a courtesy and is allowed to fail quietly.
  const delivered = await sendMail({
    to: enquiryInbox(),
    ...enquiryNotificationEmail({ name, email, phone, orgName, callsPerDay, requirements }),
  });

  // Always logged, whether or not the mail went out. pm2 and Cloud Logging are
  // then the backstop for an enquiry that email dropped — which is the whole
  // reason this line records the address and not just that something arrived.
  console.log(
    `[enquiry] ${delivered ? 'RECEIVED' : 'RECEIVED (mail failed)'} ${JSON.stringify({
      email,
      orgName,
      callsPerDay,
      ip,
    })}`,
  );

  if (!delivered) {
    return NextResponse.json(
      {
        error: `We could not send that just now. Please email ${enquiryInbox()} directly and we will pick it up.`,
      },
      { status: 502 },
    );
  }

  void sendMail({ to: email, ...enquiryAckEmail({ name, orgName, requirements }) });

  return NextResponse.json({ ok: true, replyTo: mailFrom() });
}
