import { describe, it, expect, vi, beforeEach } from 'vitest';

// Promo codes decide what a customer is charged, so these cover the cases where
// getting it wrong means undercharging (or handing out a free plan).

const findUnique = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    promoCode: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

import { applyPromo, normalizeCode, MIN_CHARGE_INR } from '@/lib/billing/promo';

const promo = (over: Record<string, unknown> = {}) => ({
  code: 'TEST10',
  active: true,
  percentOff: null,
  fixedPriceInr: null,
  plans: null,
  maxRedemptions: null,
  timesRedeemed: 0,
  expiresAt: null,
  ...over,
});

beforeEach(() => findUnique.mockReset());

describe('normalizeCode', () => {
  it('uppercases and trims so codes match however they were typed', () => {
    expect(normalizeCode('  launch50 ')).toBe('LAUNCH50');
  });
});

describe('applyPromo', () => {
  const base = { plan: 'starter', priceInr: 999 };

  it('applies a fixed price', async () => {
    findUnique.mockResolvedValue(promo({ fixedPriceInr: 10 }));
    const r = await applyPromo({ ...base, code: 'test10' });
    expect(r).toMatchObject({ ok: true, amountInr: 10, originalInr: 999 });
  });

  it('applies a percentage off', async () => {
    findUnique.mockResolvedValue(promo({ percentOff: 50 }));
    const r = await applyPromo({ ...base, code: 'TEST10' });
    expect(r).toMatchObject({ ok: true, amountInr: 499.5 });
  });

  it('rejects an unknown code', async () => {
    findUnique.mockResolvedValue(null);
    expect(await applyPromo({ ...base, code: 'NOPE' })).toMatchObject({ ok: false });
  });

  it('gives the same message for disabled as for unknown, so codes cannot be probed', async () => {
    findUnique.mockResolvedValue(null);
    const unknown = await applyPromo({ ...base, code: 'NOPE' });
    findUnique.mockResolvedValue(promo({ fixedPriceInr: 10, active: false }));
    const disabled = await applyPromo({ ...base, code: 'TEST10' });
    expect(disabled.ok).toBe(false);
    expect((disabled as { error: string }).error).toBe((unknown as { error: string }).error);
  });

  it('rejects an expired code', async () => {
    findUnique.mockResolvedValue(promo({ fixedPriceInr: 10, expiresAt: new Date(Date.now() - 1000) }));
    const r = await applyPromo({ ...base, code: 'TEST10' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/expired/i);
  });

  it('rejects a code that has hit its redemption cap', async () => {
    findUnique.mockResolvedValue(promo({ fixedPriceInr: 10, maxRedemptions: 1, timesRedeemed: 1 }));
    const r = await applyPromo({ ...base, code: 'TEST10' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/already been used/i);
  });

  it('honours a plan restriction', async () => {
    findUnique.mockResolvedValue(promo({ fixedPriceInr: 10, plans: 'growth,pro' }));
    expect(await applyPromo({ ...base, code: 'TEST10' })).toMatchObject({ ok: false });
    expect(await applyPromo({ plan: 'pro', priceInr: 4999, code: 'TEST10' })).toMatchObject({ ok: true });
  });

  it('never charges below the gateway minimum, even at 100% off', async () => {
    findUnique.mockResolvedValue(promo({ percentOff: 100 }));
    const r = await applyPromo({ ...base, code: 'TEST10' });
    expect(r).toMatchObject({ ok: true, amountInr: MIN_CHARGE_INR });
  });

  it('refuses a code that would not actually reduce the price', async () => {
    findUnique.mockResolvedValue(promo({ fixedPriceInr: 1500 }));
    expect(await applyPromo({ ...base, code: 'TEST10' })).toMatchObject({ ok: false });
  });

  it('refuses a malformed row with neither discount set', async () => {
    findUnique.mockResolvedValue(promo());
    expect(await applyPromo({ ...base, code: 'TEST10' })).toMatchObject({ ok: false });
  });

  it('rounds a percentage discount to paise', async () => {
    findUnique.mockResolvedValue(promo({ percentOff: 33 }));
    const r = await applyPromo({ ...base, code: 'TEST10' });
    // 999 * 0.67 = 669.33
    expect((r as { amountInr: number }).amountInr).toBe(669.33);
  });
});
