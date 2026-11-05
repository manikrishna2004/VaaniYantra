import { describe, it, expect, vi, beforeEach } from 'vitest';

// Credits are bought before they are spoken. This is the gate that enforces it,
// and the 10% tolerance that keeps a clinic's phone from dying on a bad
// estimate. Three things must hold:
//
//   * the gate is OFF unless armed — arming it by default would take every
//     existing clinic off the air on the deploy that shipped it;
//   * a clinic may speak 10% past its balance, and those minutes are invoiced
//     rather than blocked;
//   * the owner is told the moment the balance reaches zero, once, not once
//     per caller.

const db = vi.hoisted(() => ({
  organization: {
    findUnique: vi.fn(async (): Promise<any> => ({ plan: 'standard', prepaidMinutes: 0 })),
    updateMany: vi.fn(async (): Promise<any> => ({ count: 1 })),
  },
  membership: {
    findFirst: vi.fn(async (): Promise<any> => ({ user: { email: 'owner@clinic.in', name: 'Asha' } })),
  },
  call: { aggregate: vi.fn(async (): Promise<any> => ({ _sum: { durationSec: 0 } })) },
}));
const platform = vi.hoisted(() => ({ config: null as string | null }));
const mail = vi.hoisted(() => ({ send: vi.fn(async () => true) }));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/platform', () => ({
  getPlatformConfig: vi.fn(async () => platform.config),
  setPlatformConfig: vi.fn(async () => {}),
  getPlanOverrides: vi.fn(async () => ({})),
  isSuperAdmin: vi.fn(() => false),
}));
vi.mock('@/lib/mailer', () => ({
  sendMail: mail.send,
  creditsEmptyEmail: vi.fn(() => ({ subject: 's', text: 't', html: 'h' })),
}));

import {
  toleranceMinutes,
  allowanceMinutes,
  checkCallCredits,
  creditsRequired,
  CREDIT_TOLERANCE,
} from '@/lib/billing/credits';
import { checkCallMinutesAllowed, callMinutesLimitMessage } from '@/lib/billing/catalogue';

/** Arm or disarm the gate the way the platform config would. */
function gate(on: boolean) {
  platform.config = on ? 'on' : 'off';
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.config = null;
  delete process.env.REQUIRE_PREPAID_CREDITS;
  db.organization.updateMany.mockResolvedValue({ count: 1 });
  db.membership.findFirst.mockResolvedValue({ user: { email: 'owner@clinic.in', name: 'Asha' } });
});

describe('the tolerance', () => {
  it('is a tenth of the balance, rounded up to a whole minute', () => {
    expect(CREDIT_TOLERANCE).toBe(0.1);
    expect(toleranceMinutes(2000)).toBe(200);
    expect(toleranceMinutes(145)).toBe(15); // 14.5 rounds up — never down
    expect(allowanceMinutes(2000)).toBe(2200);
  });

  it('is nothing on an empty or negative balance', () => {
    expect(toleranceMinutes(0)).toBe(0);
    expect(toleranceMinutes(-500)).toBe(0);
    expect(allowanceMinutes(-500)).toBe(0);
  });
});

describe('the gate is off unless armed', () => {
  it('is off when nothing has been configured', async () => {
    expect(await creditsRequired()).toBe(false);
  });

  it('is off for an env value that is not exactly "on"', async () => {
    process.env.REQUIRE_PREPAID_CREDITS = 'true';
    expect(await creditsRequired()).toBe(false);
    process.env.REQUIRE_PREPAID_CREDITS = 'on';
    expect(await creditsRequired()).toBe(true);
  });

  it('lets the stored setting override the env', async () => {
    process.env.REQUIRE_PREPAID_CREDITS = 'on';
    gate(false);
    expect(await creditsRequired()).toBe(false);
  });

  // The whole reason for the default. An org with no credits and the gate off
  // must keep answering its phone.
  it('answers calls for an org with no credits at all', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 0 });
    const v = await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 900 });
    expect(v).toMatchObject({ allowed: true, required: false });
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('what the gate allows once it is armed', () => {
  beforeEach(() => gate(true));

  it('allows a call inside the balance', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 2000 });
    const v = await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 1500 });
    expect(v.allowed).toBe(true);
    expect(v.remainingMinutes).toBe(500);
  });

  it('allows a call inside the 10% tolerance past the balance', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 2000 });
    const v = await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 2150 });
    expect(v).toMatchObject({ allowed: true, remainingMinutes: 0, toleranceMinutes: 200, allowanceMinutes: 2200 });
  });

  it('stops the calls once the tolerance is spent too', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 2000 });
    expect((await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 2200 })).allowed).toBe(false);
    expect((await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 9999 })).allowed).toBe(false);
  });

  it('refuses an org that never bought any minutes', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 0 });
    expect((await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 0 })).allowed).toBe(false);
  });

  // A legacy monthly plan sold an included allowance. Stopping those clinics for
  // want of credits nobody asked them to buy would break a deal they still pay for.
  it('never gates a legacy monthly plan', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'voice_starter', prepaidMinutes: 0 });
    const v = await checkCallCredits({ orgId: 'o1', usageBased: false, usedMinutes: 5000 });
    expect(v).toMatchObject({ allowed: true, required: false });
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('the owner is told once', () => {
  beforeEach(() => {
    gate(true);
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 2000, name: 'Smilecare' });
  });

  it('emails the owner the moment the balance reaches zero — while the tolerance is still there', async () => {
    await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 2000 });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect((mail.send.mock.calls[0] as any)[0].to).toBe('owner@clinic.in');
  });

  it('says nothing while there are still minutes left', async () => {
    await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 1999 });
    expect(mail.send).not.toHaveBeenCalled();
  });

  // The claim is the month column, not a read-then-write: two calls landing
  // together must not each send.
  it('does not email again once the month is claimed', async () => {
    db.organization.updateMany.mockResolvedValue({ count: 0 });
    await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 2100 });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('does not let a mail failure stop the call from being judged', async () => {
    mail.send.mockRejectedValue(new Error('smtp down'));
    const v = await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 2100 });
    expect(v.allowed).toBe(true);
  });

  it('logs rather than throws when there is no owner to tell', async () => {
    db.membership.findFirst.mockResolvedValue(null);
    const v = await checkCallCredits({ orgId: 'o1', usageBased: true, usedMinutes: 2100 });
    expect(v.allowed).toBe(true);
    expect(mail.send).not.toHaveBeenCalled();
  });
});

// The gate has to reach the two places that actually answer and place calls,
// and both go through checkCallMinutesAllowed.
describe('checkCallMinutesAllowed carries the verdict', () => {
  it('blocks a call when the credits and the tolerance are gone', async () => {
    gate(true);
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 100 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 300 * 60 } });

    const res = await checkCallMinutesAllowed('o1');
    expect(res.allowed).toBe(false);
    expect(res.credits.allowed).toBe(false);
    expect(callMinutesLimitMessage(res.limit, res.used, res.plan, res.credits)).toMatch(/prepaid minutes/i);
  });

  it('leaves the call allowed when the gate is off', async () => {
    gate(false);
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 0 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 300 * 60 } });

    expect((await checkCallMinutesAllowed('o1')).allowed).toBe(true);
  });

  // The volume rate is uncapped, so this used to return before counting a
  // single minute — which would have exempted exactly the accounts most likely
  // to be running on bought credits.
  it('still counts the minutes on an uncapped plan', async () => {
    gate(true);
    db.organization.findUnique.mockResolvedValue({ plan: 'scale', prepaidMinutes: 1000 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 1200 * 60 } });

    const res = await checkCallMinutesAllowed('o1');
    expect(res.used).toBe(1200);
    expect(res.allowed).toBe(false);
  });
});
