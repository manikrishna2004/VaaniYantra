import { sendMail, mailerConfigured } from '@/lib/mailer';
import { KIT_PRODUCT_NAME } from '@/lib/kit/purchase';

/**
 * The receipt-and-download email.
 *
 * Sent after payment settles. It is a convenience, not the delivery mechanism
 * — the buyer is already looking at the download page when this goes out — so
 * nothing in the purchase flow waits on it or fails because of it.
 *
 * It doubles as the receipt, which is why it states the amount and order id.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendKitDownloadEmail(args: {
  to: string;
  name?: string | null;
  link: string;
  orderId: string;
  amountInr: number;
}): Promise<boolean> {
  if (!mailerConfigured()) {
    console.warn('[kit] no mail backend configured — download email not sent to', args.to);
    return false;
  }

  const hi = args.name?.trim() ? `Hi ${args.name.trim()},` : 'Hi,';
  const subject = `Your ${KIT_PRODUCT_NAME} download`;

  const text = [
    hi,
    '',
    `Thanks for buying the ${KIT_PRODUCT_NAME}. Here is your download link:`,
    '',
    args.link,
    '',
    'The link works for 7 days and up to 5 downloads. Keep the files somewhere safe —',
    'if you lose them, reply to this email and we will send a fresh link.',
    '',
    'To get started: unzip it, run `npm install`, then `npm start`, and open',
    'http://localhost:8080/setup in your browser. Every step there has instructions',
    'built in, and a Test button that checks the credential actually works.',
    '',
    `Order ${args.orderId} — Rs ${args.amountInr}, paid.`,
    '',
    '— The VaaniYantra team',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;color:#101828">
      <p>${hi}</p>
      <p>Thanks for buying the <strong>${escapeHtml(KIT_PRODUCT_NAME)}</strong>.</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(args.link)}"
           style="display:inline-block;background:#4b3fce;color:#fff;text-decoration:none;
                  padding:12px 22px;border-radius:10px;font-weight:600">Download the kit</a>
      </p>
      <p style="color:#5d6b7d;font-size:13px">The link works for 7 days and up to 5 downloads. If you lose the
      files, reply to this email and we will send a fresh link.</p>
      <p style="color:#3d4b5c">To get started: unzip it, run <code>npm install</code>, then <code>npm start</code>,
      and open <code>http://localhost:8080/setup</code>. Every step there has instructions built in, and a Test
      button that checks each credential actually works.</p>
      <p style="color:#5d6b7d;font-size:13px">Order ${escapeHtml(args.orderId)} &mdash; &#8377;${args.amountInr}, paid.</p>
      <p style="color:#5d6b7d;font-size:13px">&mdash; The VaaniYantra team</p>
    </div>`.trim();

  return sendMail({ to: args.to, subject, text, html });
}
