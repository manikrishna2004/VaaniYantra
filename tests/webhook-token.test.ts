import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  callbackToken,
  verifyCallbackToken,
  signCallbackUrl,
  webhookTokensAvailable,
} from '@/lib/webhook-token';

// These tokens are the only thing authenticating Exotel's status callback, and
// that callback writes the duration overage billing is computed from. A hole
// here is a hole in billing integrity.

const ORIGINAL = process.env.WEBHOOK_TOKEN_SECRET;

beforeEach(() => {
  process.env.WEBHOOK_TOKEN_SECRET = 'test-secret-for-callbacks';
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WEBHOOK_TOKEN_SECRET;
  else process.env.WEBHOOK_TOKEN_SECRET = ORIGINAL;
});

describe('callbackToken', () => {
  it('is deterministic for the same call and purpose', () => {
    expect(callbackToken('call_1', 'exotel-status')).toBe(callbackToken('call_1', 'exotel-status'));
  });

  it('differs per call', () => {
    expect(callbackToken('call_1', 'exotel-status')).not.toBe(callbackToken('call_2', 'exotel-status'));
  });

  it('differs per purpose, so a token cannot be replayed at another provider', () => {
    expect(callbackToken('call_1', 'exotel-status')).not.toBe(callbackToken('call_1', 'plivo-status'));
  });

  it('is URL-safe and long enough to be unguessable', () => {
    const t = callbackToken('call_1', 'exotel-status');
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(32);
  });
});

describe('verifyCallbackToken', () => {
  it('accepts the token it minted', () => {
    const t = callbackToken('call_1', 'exotel-status');
    expect(verifyCallbackToken('call_1', 'exotel-status', t)).toBe(true);
  });

  it('rejects a token minted for a different call — the actual attack', () => {
    const other = callbackToken('victim_call', 'exotel-status');
    expect(verifyCallbackToken('call_1', 'exotel-status', other)).toBe(false);
  });

  it('rejects a token minted for a different provider', () => {
    const plivo = callbackToken('call_1', 'plivo-status');
    expect(verifyCallbackToken('call_1', 'exotel-status', plivo)).toBe(false);
  });

  it('rejects missing, empty and malformed tokens rather than throwing', () => {
    expect(verifyCallbackToken('call_1', 'exotel-status', null)).toBe(false);
    expect(verifyCallbackToken('call_1', 'exotel-status', undefined)).toBe(false);
    expect(verifyCallbackToken('call_1', 'exotel-status', '')).toBe(false);
    expect(verifyCallbackToken('call_1', 'exotel-status', 'nope')).toBe(false);
  });

  it('rejects a token of the right shape but wrong content', () => {
    const t = callbackToken('call_1', 'exotel-status');
    const tampered = (t[0] === 'A' ? 'B' : 'A') + t.slice(1);
    expect(verifyCallbackToken('call_1', 'exotel-status', tampered)).toBe(false);
  });

  it('rejects everything when no secret is configured, rather than accepting all', () => {
    const t = callbackToken('call_1', 'exotel-status');
    delete process.env.WEBHOOK_TOKEN_SECRET;
    const prevEnc = process.env.SECRET_ENC_KEY;
    delete process.env.SECRET_ENC_KEY;
    try {
      expect(webhookTokensAvailable()).toBe(false);
      expect(verifyCallbackToken('call_1', 'exotel-status', t)).toBe(false);
    } finally {
      if (prevEnc !== undefined) process.env.SECRET_ENC_KEY = prevEnc;
    }
  });

  it('changes with the secret, so a leaked token dies on rotation', () => {
    const before = callbackToken('call_1', 'exotel-status');
    process.env.WEBHOOK_TOKEN_SECRET = 'rotated-secret';
    expect(verifyCallbackToken('call_1', 'exotel-status', before)).toBe(false);
  });
});

describe('signCallbackUrl', () => {
  it('appends with & when the URL already has a query', () => {
    const url = signCallbackUrl('https://x.test/api/s?callId=c1', 'c1', 'exotel-status');
    expect(url).toContain('?callId=c1&t=');
    const token = new URL(url).searchParams.get('t');
    expect(verifyCallbackToken('c1', 'exotel-status', token)).toBe(true);
  });

  it('appends with ? when the URL has none', () => {
    const url = signCallbackUrl('https://x.test/api/s', 'c1', 'exotel-status');
    expect(url).toContain('?t=');
  });

  it('round-trips through URL parsing intact', () => {
    const url = signCallbackUrl('https://x.test/api/s?callId=c1', 'c1', 'plivo-status');
    const parsed = new URL(url);
    expect(verifyCallbackToken('c1', 'plivo-status', parsed.searchParams.get('t'))).toBe(true);
  });
});
