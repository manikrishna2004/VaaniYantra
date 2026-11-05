import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { twilioSignature, verifyTwilioSignature } from '@/lib/telephony-signature';

// Reference vector computed exactly per Twilio's documented scheme:
// base64(HMAC-SHA1(token, url + sorted(key+value)…)).
const TOKEN = '12345';
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+12349013030',
  Digits: '1234',
  From: '+12349013030',
  To: '+18005551212',
};

function reference(): string {
  const data = URL_ + Object.keys(PARAMS).sort().map((k) => k + (PARAMS as any)[k]).join('');
  return crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
}

describe('twilioSignature', () => {
  beforeEach(() => {
    delete process.env.TWILIO_VALIDATE_SIGNATURE;
  });

  it('matches the documented HMAC-SHA1 construction', () => {
    expect(twilioSignature(TOKEN, URL_, PARAMS)).toBe(reference());
  });

  it('accepts a correctly signed request', () => {
    expect(
      verifyTwilioSignature({ authTokens: [TOKEN], url: URL_, params: PARAMS, signature: reference() }),
    ).toBe(true);
  });

  it('accepts when any candidate token matches', () => {
    expect(
      verifyTwilioSignature({
        authTokens: ['wrong', null, TOKEN],
        url: URL_,
        params: PARAMS,
        signature: reference(),
      }),
    ).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifyTwilioSignature({ authTokens: [TOKEN], url: URL_, params: PARAMS, signature: null })).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(
      verifyTwilioSignature({ authTokens: ['not-the-token'], url: URL_, params: PARAMS, signature: reference() }),
    ).toBe(false);
  });

  it('rejects tampered params', () => {
    expect(
      verifyTwilioSignature({
        authTokens: [TOKEN],
        url: URL_,
        params: { ...PARAMS, To: '+10000000000' },
        signature: reference(),
      }),
    ).toBe(false);
  });

  it('can be disabled via TWILIO_VALIDATE_SIGNATURE=false', () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    expect(verifyTwilioSignature({ authTokens: [], url: URL_, params: PARAMS, signature: null })).toBe(true);
  });
});
