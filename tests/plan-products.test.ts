import { describe, it, expect } from 'vitest';
import {
  PLANS,
  PLAN_ORDER,
  RATE_PER_MINUTE_INR,
  SCALE_RATE_PER_MINUTE_INR,
  DEFAULT_NEW_ORG_PLAN,
  isBuyable,
  isPlanKey,
  livePlans,
  overageFor,
} from '@/lib/billing/catalogue';

// The catalogue went from three product lines to a single per-minute rate while
// live orgs sat on the old keys — twice over, since those keys were themselves
// the survivors of an earlier restructure. These pin down the properties that
// made each move safe, so a future edit can't quietly break a paying clinic or
// hand one a free account.

describe('retired plans', () => {
  const RETIRED = [
    'free', 'starter', 'growth', 'pro', 'business', 'enterprise',
    'bundle_clinic', 'bundle_practice', 'bundle_hospital',
    'voice_starter', 'voice_growth', 'voice_pro',
    'chat_starter', 'chat_growth', 'chat_pro',
  ] as const;

  it('still resolve, so no live org is stranded on an unknown plan', () => {
    for (const key of RETIRED) expect(isPlanKey(key)).toBe(true);
  });

  it('keep their original prices — repricing them would change what an existing clinic pays', () => {
    expect(PLANS.starter.priceMonthly).toBe(999);
    expect(PLANS.growth.priceMonthly).toBe(2999);
    expect(PLANS.pro.priceMonthly).toBe(7999);
    expect(PLANS.business.priceMonthly).toBe(19999);
    expect(PLANS.bundle_clinic.priceMonthly).toBe(2999);
    expect(PLANS.voice_starter.priceMonthly).toBe(999);
  });

  it('are every one of them holdable but never buyable', () => {
    for (const key of RETIRED) {
      expect(PLANS[key].legacy).toBe(true);
      expect(isBuyable(PLANS[key])).toBe(false);
    }
  });

  it('still bill overage exactly as they did, for the orgs still on them', () => {
    // 475 included at ₹7/min overage.
    expect(overageFor(PLANS.bundle_clinic, 475)).toEqual({ minutes: 0, amountInr: 0 });
    expect(overageFor(PLANS.bundle_clinic, 500)).toEqual({ minutes: 25, amountInr: 175 });
  });

  it('never bills a chatbot-only plan for call minutes', () => {
    // Guards the sweep: a chat plan has a 0 limit, so a naive used - limit
    // would bill for every minute somehow recorded.
    expect(overageFor(PLANS.chat_starter, 0)).toEqual({ minutes: 0, amountInr: 0 });
    expect(overageFor(PLANS.chat_starter, 120)).toEqual({ minutes: 0, amountInr: 0 });
  });
});

describe('the one rate', () => {
  it('is what the catalogue offers, and all it offers', () => {
    expect(livePlans(PLAN_ORDER.map((k) => PLANS[k])).map((p) => p.key)).toEqual(['standard', 'scale']);
  });

  it('quotes ₹5, and ₹4.5 at volume', () => {
    expect(RATE_PER_MINUTE_INR).toBe(5);
    expect(SCALE_RATE_PER_MINUTE_INR).toBe(4.5);
    expect(PLANS.standard.pricePerMinute).toBe(5);
    expect(PLANS.scale.pricePerMinute).toBe(4.5);
  });

  it('charges nothing up front — there is no monthly fee to buy', () => {
    for (const p of [PLANS.standard, PLANS.scale]) {
      expect(p.priceMonthly).toBe(0);
      expect(isBuyable(p)).toBe(false);
    }
  });

  it('is where a new organisation lands', () => {
    expect(DEFAULT_NEW_ORG_PLAN).toBe('standard');
    expect(PLANS[DEFAULT_NEW_ORG_PLAN].usageBased).toBe(true);
  });

  it('carries an overage rate equal to the rate, or the sweep would bill nothing', () => {
    // The monthly sweep only looks at plans with overagePerMinute > 0. A usage
    // plan without one is a free account that nobody notices until the quarter.
    expect(PLANS.standard.overagePerMinute).toBe(RATE_PER_MINUTE_INR);
    expect(PLANS.scale.overagePerMinute).toBe(SCALE_RATE_PER_MINUTE_INR);
  });
});

describe('overageFor on a usage plan — this is the whole bill', () => {
  it('bills from the first minute, with no allowance to use up', () => {
    expect(overageFor(PLANS.standard, 0)).toEqual({ minutes: 0, amountInr: 0 });
    expect(overageFor(PLANS.standard, 1)).toEqual({ minutes: 1, amountInr: 5 });
    expect(overageFor(PLANS.standard, 200)).toEqual({ minutes: 200, amountInr: 1000 });
  });

  it('bills an uncapped plan rather than falling through the Infinity guard', () => {
    // The Scale rate is deliberately uncapped. The metered branch returns zero
    // for a non-finite limit, so checking usageBased first is what stops our
    // largest customers being billed nothing at all.
    expect(PLANS.scale.limits.callMinutesPerMonth).toBe(Infinity);
    expect(overageFor(PLANS.scale, 10_000)).toEqual({ minutes: 10_000, amountInr: 45_000 });
  });

  it('rounds money to paise, not to rupees', () => {
    expect(overageFor(PLANS.scale, 3)).toEqual({ minutes: 3, amountInr: 13.5 });
  });
});

describe('the catalogue as a whole', () => {
  it('lists every plan exactly once in the display order', () => {
    expect(new Set(PLAN_ORDER).size).toBe(PLAN_ORDER.length);
    expect(PLAN_ORDER.length).toBe(Object.keys(PLANS).length);
  });

  it('sells nothing self-serve — every key is retired or usage-based', () => {
    for (const key of PLAN_ORDER) expect(isBuyable(PLANS[key])).toBe(false);
  });
});
