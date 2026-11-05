import { fetchWithTimeout } from '@/lib/net/fetch';

// Transactional email.
//
// Contract deliberately mirrors sendConfirmation() in src/lib/connectors.ts:
// it NEVER throws and returns a boolean. Email is a side-channel — an invite that fails
// to send must not fail the request that created it, because the invite link
// still exists and can be copied by hand.
//
// Two backends, no new dependency for the common case:
//   • Resend, over plain fetch, when RESEND_API_KEY is set. Matches how the rest
//     of this codebase talks to third parties (see google-oauth.ts) — no SDK.
//   • SMTP via a DYNAMIC import of nodemailer when SMTP_URL is set. Dynamic so
//     the package is only required by installs that actually use SMTP; the
//     import failing is treated as "not configured", not as an error.
//
// With neither configured, sendMail returns false and callers fall back to
// showing the link.

export type MailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/** Whether any mail backend is configured. Used to shape the UI up front. */
export function mailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_URL);
}

/**
 * The From address on everything we send.
 *
 * Defaults to the business address published on /privacy, /terms, /dpa and
 * /contact — the same one customers already know us by. Deliberately not a
 * `noreply@`: a verification code arriving from an address the recipient can
 * look up (and reply to) is the one that survives a spam filter and a suspicious
 * clinic manager. Overridable with MAIL_FROM, but the default is a real mailbox
 * on purpose.
 *
 * ⚠ Whatever this resolves to, its DOMAIN must be verified with the sending
 * provider. An unverified domain is rejected outright by Resend, and lands in
 * spam over SMTP — and for sign-up codes that is not a degraded experience, it
 * is a customer who cannot create an account at all.
 */
export function mailFrom(): string {
  return process.env.MAIL_FROM || 'VaaniYantra <info@vaaniyantra.com>';
}

export async function sendMail(input: MailInput): Promise<boolean> {
  const to = input.to.trim();
  if (!to) return false;

  if (process.env.RESEND_API_KEY) return sendViaResend(to, input);
  if (process.env.SMTP_URL) return sendViaSmtp(to, input);

  console.warn('[mailer] no mail backend configured (set RESEND_API_KEY or SMTP_URL) — not sending');
  return false;
}

async function sendViaResend(to: string, input: MailInput): Promise<boolean> {
  try {
    const res = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailFrom(),
        to: [to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      }),
      timeoutMs: 15_000,
      retries: 1,
    });
    if (!res.ok) {
      console.error('[mailer] resend send failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mailer] resend send error', err);
    return false;
  }
}

async function sendViaSmtp(to: string, input: MailInput): Promise<boolean> {
  try {
    // Optional backend: nodemailer is NOT a dependency of this project, so the
    // specifier is a variable rather than a literal — that stops TypeScript and
    // the bundler from trying to resolve a package that may not be installed,
    // and turns "not installed" into a caught runtime miss instead of a build
    // failure for everyone using Resend.
    const specifier = 'nodemailer';
    const mod: any = await import(/* webpackIgnore: true */ specifier).catch(() => null);
    if (!mod) {
      console.error('[mailer] SMTP_URL is set but nodemailer is not installed — run `npm i nodemailer`');
      return false;
    }
    const transport = (mod.default ?? mod).createTransport(process.env.SMTP_URL);
    await transport.sendMail({
      from: mailFrom(),
      to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return true;
  } catch (err) {
    console.error('[mailer] smtp send error', err);
    return false;
  }
}

/**
 * The "you've been invited" email.
 *
 * Plain text carries the whole message and the link is spelled out in full —
 * a doctor forwarding this from a phone, or a mail client stripping HTML,
 * should still be able to join.
 */
export function inviteEmail(args: {
  orgName: string;
  inviterName: string;
  role: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const role = args.role.charAt(0) + args.role.slice(1).toLowerCase();
  const subject = `${args.inviterName} invited you to ${args.orgName} on VaaniYantra`;

  const text = [
    `${args.inviterName} has invited you to join ${args.orgName} on VaaniYantra as a ${role}.`,
    '',
    'VaaniYantra is the AI front desk for their practice — it answers patient calls, books appointments,',
    'and gives patients a chatbot for their prescriptions.',
    '',
    'Accept your invitation:',
    args.url,
    '',
    'Once you join, connect your own Google Calendar under Connectors so patients get booked with you.',
    '',
    'This invitation expires in 7 days. If you were not expecting it, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1f;max-width:520px">
      <p><strong>${escapeHtml(args.inviterName)}</strong> has invited you to join
      <strong>${escapeHtml(args.orgName)}</strong> on VaaniYantra as a ${escapeHtml(role)}.</p>
      <p style="color:#55555f">VaaniYantra is the AI front desk for their practice — it answers patient calls,
      books appointments, and gives patients a chatbot for their prescriptions.</p>
      <p style="margin:28px 0">
        <a href="${escapeHtml(args.url)}"
           style="background:#4b3fce;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">
          Accept invitation
        </a>
      </p>
      <p style="color:#55555f;font-size:13px">Or paste this link into your browser:<br>
        <a href="${escapeHtml(args.url)}" style="color:#3a2fa8;word-break:break-all">${escapeHtml(args.url)}</a>
      </p>
      <p style="color:#55555f;font-size:13px">Once you join, connect your own Google Calendar under
      <strong>Connectors</strong> so patients get booked with you.</p>
      <hr style="border:none;border-top:1px solid #e5e5ea;margin:24px 0">
      <p style="color:#8a8a94;font-size:12px">This invitation expires in 7 days.
      If you weren’t expecting it, you can ignore this email.</p>
    </div>`;

  return { subject, text, html };
}

/**
 * The "here is your code" email that gates account creation.
 *
 * Deliberately austere: no marketing, no links, one number. A verification mail
 * that looks like a newsletter is the one that gets filtered, and this is the
 * mail a new customer cannot get past us without.
 *
 * The code is repeated in the subject line so it is readable from a phone's
 * notification without opening anything.
 */
/**
 * Walkthrough confirmation, sent from OUR domain.
 *
 * Google also sends its own calendar invitation for the same booking, and that
 * is deliberate rather than duplication: the invite is what puts the meeting in
 * the prospect's calendar and what carries any later reschedule or cancellation
 * to them. It comes from whichever Google account is connected, though — so
 * this is the mail that actually greets them, from an address on our own
 * domain, carrying the joining link. Set `notifyAttendees: false` on the event
 * if you ever want ours to be the only one, and accept that a moved meeting
 * then reaches nobody.
 */
/**
 * The two halves of an integration enquiry: what the prospect gets back, and
 * what lands in our own inbox.
 *
 * This replaces the walkthrough confirmation. A booked slot confirmed itself —
 * the time was the message. An enquiry has no time in it, so the acknowledgement
 * has to do the work instead: repeat what they told us, so they can see it
 * arrived, and say when a human will answer.
 */
export function enquiryAckEmail(args: {
  name?: string | null;
  orgName: string;
  requirements: string;
}): { subject: string; text: string; html: string } {
  const hi = args.name?.trim() ? `Hi ${args.name.trim()},` : 'Hi,';
  const subject = 'We have your enquiry — VaaniYantra';

  const text = [
    hi,
    '',
    `Thanks for telling us about ${args.orgName}. We have read it, and one of us will come back`,
    'to you within one working day with what it would take to fit VaaniYantra to how you',
    'already work — your numbers, your systems, your consultants.',
    '',
    'What you sent us:',
    args.requirements,
    '',
    'If anything is missing, just reply to this email and it reaches the same person.',
    '',
    '— The VaaniYantra team',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;color:#101828">
      <p>${hi}</p>
      <p>Thanks for telling us about <strong>${escapeHtml(args.orgName)}</strong>. We have read it, and one of us
      will come back to you within one working day with what it would take to fit VaaniYantra to how you already
      work &mdash; your numbers, your systems, your consultants.</p>
      <p style="color:#3d4b5c">What you sent us:</p>
      <blockquote style="margin:0;padding:12px 16px;border-left:3px solid #4b3fce;background:#f4f6fa;color:#3d4b5c;white-space:pre-wrap">${escapeHtml(args.requirements)}</blockquote>
      <p style="color:#5d6b7d;font-size:13px">If anything is missing, just reply to this email and it reaches the
      same person.</p>
      <p style="color:#5d6b7d;font-size:13px">&mdash; The VaaniYantra team</p>
    </div>`.trim();

  return { subject, text, html };
}

/** The internal copy. Plain and dense — it is a work item, not a marketing email. */
export function enquiryNotificationEmail(args: {
  name: string;
  email: string;
  phone: string;
  orgName: string;
  callsPerDay: string;
  requirements: string;
}): { subject: string; text: string; html: string } {
  const subject = `Enquiry: ${args.orgName}${args.callsPerDay ? ` (~${args.callsPerDay} calls/day)` : ''}`;
  const rows: [string, string][] = [
    ['Name', args.name || '—'],
    ['Email', args.email],
    ['Phone', args.phone || '—'],
    ['Clinic / hospital', args.orgName],
    ['Calls per day', args.callsPerDay || '—'],
  ];

  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'What they need:',
    args.requirements,
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#101828">
      <table style="border-collapse:collapse;font-size:14px">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#5d6b7d">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
          )
          .join('')}
      </table>
      <p style="color:#5d6b7d;margin-top:16px">What they need:</p>
      <blockquote style="margin:0;padding:12px 16px;border-left:3px solid #4b3fce;background:#f4f6fa;white-space:pre-wrap">${escapeHtml(args.requirements)}</blockquote>
    </div>`.trim();

  return { subject, text, html };
}

/**
 * The owner's warning that the prepaid minutes have run out.
 *
 * Sent while the 10% tolerance is still unspent, so it is a "top up today"
 * email rather than a "your phone stopped" one. It says exactly how much runway
 * is left, because that is the only number that decides how urgently they act.
 */
export function creditsEmptyEmail(args: {
  name?: string | null;
  orgName: string;
  balanceMinutes: number;
  toleranceMinutes: number;
  baseUrl?: string;
}): { subject: string; text: string; html: string } {
  const hi = args.name?.trim() ? `Hi ${args.name.trim()},` : 'Hi,';
  const subject = `${args.orgName} has run out of call minutes`;
  const tolerance = args.toleranceMinutes.toLocaleString('en-IN');
  const link = args.baseUrl ? `${args.baseUrl}/settings/billing` : 'Settings → Billing';

  const text = [
    hi,
    '',
    `${args.orgName} has now used all of its prepaid call minutes.`,
    '',
    `Your agents are still answering: there are ${tolerance} minutes of tolerance on top of`,
    'the balance, and those minutes are invoiced with next month’s usage. Once they are',
    'gone the line stops answering until you top up.',
    '',
    `Buy more minutes: ${link}`,
    '',
    '— The VaaniYantra team',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;color:#101828">
      <p>${hi}</p>
      <p><strong>${escapeHtml(args.orgName)}</strong> has now used all of its prepaid call minutes.</p>
      <p>Your agents are still answering: there are <strong>${tolerance} minutes</strong> of tolerance on top of
      the balance, and those minutes are invoiced with next month&rsquo;s usage. Once they are gone the line
      stops answering until you top up.</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#4b3fce;color:#fff;border-radius:6px;text-decoration:none">Buy more minutes</a></p>
      <p style="color:#5d6b7d;font-size:13px">&mdash; The VaaniYantra team</p>
    </div>`.trim();

  return { subject, text, html };
}

export function verificationEmail(args: { code: string; name?: string | null }): {
  subject: string;
  text: string;
  html: string;
} {
  const greeting = args.name?.trim() ? `Hi ${args.name.trim()},` : 'Hi,';
  const subject = `${args.code} is your VaaniYantra verification code`;

  const text = [
    greeting,
    '',
    'Use this code to finish creating your VaaniYantra account:',
    '',
    args.code,
    '',
    'The code expires in 15 minutes and can only be used once.',
    '',
    'If you did not try to create an account, you can ignore this email — nobody',
    'can get into the account without this code.',
    '',
    '— VaaniYantra',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1f;max-width:520px">
      <p>${escapeHtml(greeting)}</p>
      <p>Use this code to finish creating your VaaniYantra account:</p>
      <p style="margin:28px 0">
        <span style="display:inline-block;background:#f4f4f6;border:1px solid #e5e5ea;border-radius:10px;
                     padding:14px 24px;font-size:30px;font-weight:700;letter-spacing:7px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
          ${escapeHtml(args.code)}
        </span>
      </p>
      <p style="color:#55555f">The code expires in 15 minutes and can only be used once.</p>
      <hr style="border:none;border-top:1px solid #e5e5ea;margin:24px 0">
      <p style="color:#8a8a94;font-size:12px">If you didn’t try to create an account, you can ignore this
      email — nobody can get into the account without this code.</p>
    </div>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
