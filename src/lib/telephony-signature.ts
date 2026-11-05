import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';

// Twilio webhook authenticity. Twilio signs every request with
// X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + sorted(key+value)…)),
// where `url` is the full public URL (scheme + host + path + query) Twilio was
// given. Numbers can live under BYO Twilio accounts, so verification tries every
// plausible auth token (platform env + the account owning the number/call).
//
// Set TWILIO_VALIDATE_SIGNATURE=false to disable (e.g. local testing without
// real Twilio traffic).

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function signatureValidationEnabled(): boolean {
  return process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';
}

export function verifyTwilioSignature(opts: {
  authTokens: Array<string | null | undefined>;
  url: string;
  params: Record<string, string>;
  signature: string | null | undefined;
}): boolean {
  if (!signatureValidationEnabled()) return true;
  if (!opts.signature) return false;
  const sig = Buffer.from(opts.signature);
  for (const token of opts.authTokens) {
    if (!token) continue;
    const expected = Buffer.from(twilioSignature(token, opts.url, opts.params));
    if (expected.length === sig.length && crypto.timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

// Every auth token this webhook could legitimately have been signed with:
// the platform env token, the account owning the dialed number (inbound), and
// the account that placed the call (outbound callbacks carry our callId).
export async function candidateTwilioTokens(hints: { to?: string | null; callId?: string | null }): Promise<string[]> {
  const tokens = new Set<string>();
  if (process.env.TWILIO_AUTH_TOKEN) tokens.add(process.env.TWILIO_AUTH_TOKEN);

  try {
    if (hints.to && hints.to !== 'unknown') {
      const num = await prisma.phoneNumber.findUnique({
        where: { e164: hints.to },
        include: { twilioAccount: { select: { authToken: true } } },
      });
      if (num?.twilioAccount?.authToken) tokens.add(decryptSecret(num.twilioAccount.authToken));
    }
    if (hints.callId) {
      const call = await prisma.call.findUnique({
        where: { id: hints.callId },
        select: { phoneNumber: { select: { twilioAccount: { select: { authToken: true } } } } },
      });
      const enc = call?.phoneNumber?.twilioAccount?.authToken;
      if (enc) tokens.add(decryptSecret(enc));
    }
  } catch (err) {
    console.error('[twilio-sig] token lookup failed', err);
  }
  return Array.from(tokens);
}

// Verify a Twilio webhook arriving as a fetch Request (Next.js route handler).
// Pass the already-read FormData (the body can only be consumed once).
export async function verifyTwilioRequest(req: Request, form: FormData | null): Promise<boolean> {
  if (!signatureValidationEnabled()) return true;
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  form?.forEach((v, k) => {
    params[k] = String(v);
  });
  const tokens = await candidateTwilioTokens({ to: params.To, callId: url.searchParams.get('callId') });
  const publicUrl = publicUrlFromHeaders(
    { host: req.headers.get('host'), forwardedProto: req.headers.get('x-forwarded-proto') },
    url.pathname + url.search,
  );
  const ok = verifyTwilioSignature({
    authTokens: tokens,
    url: publicUrl,
    params,
    signature: req.headers.get('x-twilio-signature'),
  });
  if (!ok) console.error('[twilio-sig] rejected webhook with missing/invalid signature:', publicUrl);
  return ok;
}

// Reconstruct the public URL Twilio signed against, trusting the reverse
// proxy's forwarding headers (Caddy sets X-Forwarded-Proto).
export function publicUrlFromHeaders(headers: {
  host?: string | string[] | null;
  forwardedProto?: string | string[] | null;
}, pathWithQuery: string): string {
  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  const proto = Array.isArray(headers.forwardedProto) ? headers.forwardedProto[0] : headers.forwardedProto;
  return `${proto || 'https'}://${host || 'localhost'}${pathWithQuery}`;
}
