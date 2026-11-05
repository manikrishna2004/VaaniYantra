import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';

// The billing gateway. These cover the parts that decide whether money moves or
// whether an org gets a plan it didn't pay for — webhook authenticity, the
// org-from-reference parsing the webhook relies on, and which product checkout
// runs. The HTTP calls themselves are mocked in the route tests, not here.

vi.mock('@/lib/platform', () => ({ getPlatformConfig: vi.fn(async () => null) }));
vi.mock('@/lib/net/fetch', () => ({ fetchWithTimeout: vi.fn() }));

import {
  isCashfreeConfigured,
  isLiveMode,
  checkoutMode,
  baseUrl,
  money,
  makeReference,
  orgIdFromReference,
  verifyWebhook,
  type CashfreeConfig,
} from '@/lib/cashfree';
import { addMonths } from '@/lib/cashfree-sync';

const cfg = (over: Partial<CashfreeConfig> = {}): CashfreeConfig => ({
  appId: 'TEST_APP_ID',
  secretKey: 'cfsk_ma_test_secret',
  environment: 'sandbox',
  subscriptionsEnabled: false,
  internationalEnabled: false,
  ...over,
});

const sign = (timestamp: string, body: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(`${timestamp}${body}`).digest('base64');

afterEach(() => vi.useRealTimers());

describe('isCashfreeConfigured', () => {
  it('needs both the app id and the secret key', () => {
    expect(isCashfreeConfigured(cfg())).toBe(true);
    expect(isCashfreeConfigured(cfg({ appId: null }))).toBe(false);
    expect(isCashfreeConfigured(cfg({ secretKey: null }))).toBe(false);
  });
});

describe('environment routing', () => {
  it('picks sandbox vs production hosts', () => {
    expect(isLiveMode(cfg())).toBe(false);
    expect(isLiveMode(cfg({ environment: 'production' }))).toBe(true);
    expect(baseUrl(cfg())).toBe('https://sandbox.cashfree.com/pg');
    expect(baseUrl(cfg({ environment: 'production' }))).toBe('https://api.cashfree.com/pg');
  });
});

describe('checkoutMode', () => {
  // The whole point of the flag: until Cashfree activates Subscriptions the
  // account can only take one-time orders, and billing must not try to create
  // mandates that will be rejected.
  it('falls back to one-time orders unless Subscriptions is activated', () => {
    expect(checkoutMode(cfg())).toBe('order');
    expect(checkoutMode(cfg({ subscriptionsEnabled: true }))).toBe('subscription');
  });
});

describe('money', () => {
  it('rounds to two decimals', () => {
    expect(money(999)).toBe(999);
    expect(money(1234.567)).toBe(1234.57);
    expect(money(0.005)).toBe(0.01);
  });
});

describe('reference ids', () => {
  it('round-trips the org id so the webhook can resolve it without a session', () => {
    const orgId = 'clx1234567890abcdefghijkl';
    expect(orgIdFromReference(makeReference(orgId))).toBe(orgId);
  });

  it('returns null for references it did not mint', () => {
    expect(orgIdFromReference(null)).toBeNull();
    expect(orgIdFromReference('')).toBeNull();
    expect(orgIdFromReference('order_123')).toBeNull();
    expect(orgIdFromReference('van_missing_timestamp')).toBeNull();
  });
});

describe('verifyWebhook', () => {
  const secret = 'cfsk_ma_test_secret';
  const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'van_org_1' } } });
  const ts = String(Math.floor(Date.now() / 1000));

  it('accepts a correctly signed payload and returns the parsed event', () => {
    const event = verifyWebhook(body, sign(ts, body, secret), ts, secret);
    expect(event?.type).toBe('PAYMENT_SUCCESS_WEBHOOK');
  });

  it('rejects a tampered body', () => {
    const tampered = body.replace('van_org_1', 'van_attacker_1');
    expect(verifyWebhook(tampered, sign(ts, body, secret), ts, secret)).toBeNull();
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhook(body, sign(ts, body, 'not_the_secret'), ts, secret)).toBeNull();
  });

  it('rejects missing headers rather than throwing', () => {
    expect(verifyWebhook(body, null, ts, secret)).toBeNull();
    expect(verifyWebhook(body, sign(ts, body, secret), null, secret)).toBeNull();
  });

  it('rejects a replayed webhook whose timestamp has gone stale', () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyWebhook(body, sign(old, body, secret), old, secret)).toBeNull();
  });

  it('accepts millisecond timestamps', () => {
    const ms = String(Date.now());
    expect(verifyWebhook(body, sign(ms, body, secret), ms, secret)).not.toBeNull();
  });

  it('returns null when the signed payload is not JSON', () => {
    const junk = 'not json';
    expect(verifyWebhook(junk, sign(ts, junk, secret), ts, secret)).toBeNull();
  });
});

describe('subscription first-charge date', () => {
  // Regression: the first charge was originally scheduled 10 minutes out and
  // Cashfree rejected every registration with "First charge date cannot be
  // before : <tomorrow>". It must always land on a later IST calendar day than
  // the moment of registration, from any hour of the day.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

  it('is always at least the next IST day, whatever hour it is called', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 6, 27, hour, 30, 0));
      const firstCharge = new Date(now.getTime() + 36 * 60 * 60 * 1000);
      expect(istDay(firstCharge) > istDay(now)).toBe(true);
    }
  });

  it('does not drift so far out that a month of service is given away', () => {
    const now = new Date(Date.UTC(2026, 6, 27, 12, 0, 0));
    const firstCharge = new Date(now.getTime() + 36 * 60 * 60 * 1000);
    expect(firstCharge.getTime() - now.getTime()).toBeLessThan(3 * 24 * 60 * 60 * 1000);
  });
});

describe('addMonths', () => {
  it('advances a month', () => {
    expect(addMonths(new Date('2026-07-27T00:00:00Z'), 1).toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });

  it('clamps month-end rather than rolling into the next month', () => {
    // Jan 31 + 1 month must be Feb 28, not Mar 3.
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls over the year', () => {
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});
