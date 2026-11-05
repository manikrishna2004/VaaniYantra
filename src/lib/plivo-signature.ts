import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';

// Plivo webhook authenticity (X-Plivo-Signature-V3 + X-Plivo-Signature-V3-Nonce).
// Plivo signs with base64(HMAC-SHA256(auth_token, url + nonce)).
//
// This is DEFAULT-OFF: set PLIVO_VALIDATE_SIGNATURE=true to enforce it. Off
// matches the existing unsigned inbound posture for the other BYO PSTN provider
// (Exotel), and avoids rejecting legitimate calls before the exact V3 payload has
// been confirmed against live Plivo traffic. Turn it on once verified.
//
// Numbers live under BYO Plivo accounts, so verification tries every plausible
// auth token (the account owning the dialled number, and the account that placed
// an outbound call — whose callId rides on the status/answer query).

export function plivoSignatureValidationEnabled(): boolean {
  return process.env.PLIVO_VALIDATE_SIGNATURE === 'true';
}

export function plivoV3Signature(authToken: string, url: string, nonce: string): string {
  return crypto.createHmac('sha256', authToken).update(url + nonce).digest('base64');
}

export function verifyPlivoSignature(opts: {
  authTokens: Array<string | null | undefined>;
  url: string;
  nonce: string | null | undefined;
  signature: string | null | undefined;
}): boolean {
  if (!plivoSignatureValidationEnabled()) return true;
  if (!opts.signature || !opts.nonce) return false;
  const sig = Buffer.from(opts.signature);
  for (const token of opts.authTokens) {
    if (!token) continue;
    const expected = Buffer.from(plivoV3Signature(token, opts.url, opts.nonce));
    if (expected.length === sig.length && crypto.timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

// Every auth token this webhook could legitimately have been signed with: the
// account owning the dialled number (inbound), and the account that placed the
// call (outbound callbacks carry our callId).
export async function candidatePlivoTokens(hints: {
  to?: string | null;
  callId?: string | null;
}): Promise<string[]> {
  const tokens = new Set<string>();
  try {
    if (hints.to && hints.to !== 'unknown') {
      const e164 = hints.to.startsWith('+') ? hints.to : '+' + hints.to.replace(/\D/g, '');
      const num = await prisma.phoneNumber.findUnique({
        where: { e164 },
        include: { plivoAccount: { select: { authToken: true } } },
      });
      if (num?.plivoAccount?.authToken) tokens.add(decryptSecret(num.plivoAccount.authToken));
    }
    if (hints.callId) {
      const call = await prisma.call.findUnique({
        where: { id: hints.callId },
        select: { phoneNumber: { select: { plivoAccount: { select: { authToken: true } } } } },
      });
      const enc = call?.phoneNumber?.plivoAccount?.authToken;
      if (enc) tokens.add(decryptSecret(enc));
    }
  } catch (err) {
    console.error('[plivo-sig] token lookup failed', err);
  }
  return Array.from(tokens);
}
