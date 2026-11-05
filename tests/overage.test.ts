import { describe, it, expect } from 'vitest';
import { overageFor, PLANS } from '@/lib/billing/catalogue';

// P1-8: the dashboard banner surfaces overage minutes + ₹ from overageFor().

describe('overageFor', () => {
  it('is zero within the included allowance', () => {
    expect(overageFor(PLANS.starter, 100)).toEqual({ minutes: 0, amountInr: 0 });
    expect(overageFor(PLANS.starter, 143)).toEqual({ minutes: 0, amountInr: 0 });
  });

  it('bills extra minutes at the plan overage rate', () => {
    const o = overageFor(PLANS.starter, 150); // 7 past 143 @ ₹8
    expect(o.minutes).toBe(7);
    expect(o.amountInr).toBe(56);
  });

  it('is zero for plans without an overage rate (Free)', () => {
    expect(overageFor(PLANS.free, 999)).toEqual({ minutes: 0, amountInr: 0 });
  });

  it('is zero for unlimited plans (Enterprise)', () => {
    expect(overageFor(PLANS.enterprise, 99999)).toEqual({ minutes: 0, amountInr: 0 });
  });
});
