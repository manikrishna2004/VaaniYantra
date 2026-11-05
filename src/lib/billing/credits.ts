import { prisma } from '@/lib/db';
import { getPlatformConfig, setPlatformConfig } from '@/lib/platform';
import { sendMail, creditsEmptyEmail } from '@/lib/mailer';

// ── The credit gate ─────────────────────────────────────────────────────────
//
// Minutes are bought before they are spoken. This is the part that enforces it:
// once a clinic has used everything it prepaid, it gets a tolerance of 10% more
// and then the line stops answering.
//
// Why a tolerance at all, rather than a hard stop at zero: a call in progress
// when the balance runs out, or a busy afternoon that lands 30 minutes past the
// estimate, must not become a clinic whose phone went dead without warning. The
// 10% is the runway in which the owner — who is emailed the moment the balance
// reaches zero — can top up. Those extra minutes are real minutes and they are
// invoiced with the next month's sweep, which already bills everything the
// balance did not cover. Nothing about billing changes here; only whether the
// call is answered.
//
// Deliberately NOT in billing.ts. That module owns plan allowances and is
// imported by prepaid.ts; putting the gate here keeps the dependency running
// one way (billing → credits) instead of tying the two modules in a knot.

/** Extra proportion of the balance a clinic may run past zero before calls stop. */
export const CREDIT_TOLERANCE = 0.1;

/** `Organization.billingModel`. `prepaid_wallet` is credit-gated whatever plan key it holds. */
export const PREPAID_WALLET = 'prepaid_wallet';

/**
 * Is this org on the prepaid wallet?
 *
 * Two ways in, and both are needed:
 *
 *   • `billingModel === 'prepaid_wallet'` — stated outright on the org. This is
 *     the one that works for a client sold a RateCard while still holding a
 *     legacy plan key, which the inference below gets wrong.
 *   • a usage-based plan — the inference every org on the platform runs on
 *     today, kept so the column's `legacy` default changes nothing.
 */
export function isPrepaidWallet(
  org: { billingModel?: string | null } | null | undefined,
  usageBased: boolean,
): boolean {
  return usageBased || org?.billingModel === PREPAID_WALLET;
}

export const CREDIT_KEYS = { required: 'credits_required' } as const;

/**
 * Is the gate armed?
 *
 * Off unless switched on, and that default is the important half. Every clinic
 * on the platform today has a zero balance because credits did not exist when
 * they were onboarded — arming this by default would take every one of them off
 * the air on the deploy that shipped it. It is turned on once the accounts that
 * should have credits have them.
 */
export async function creditsRequired(): Promise<boolean> {
  try {
    const raw = await getPlatformConfig(CREDIT_KEYS.required);
    if (raw === 'on') return true;
    if (raw === 'off') return false;
  } catch {
    /* fall through to the env default */
  }
  return (process.env.REQUIRE_PREPAID_CREDITS ?? 'off').trim().toLowerCase() === 'on';
}

export async function setCreditsRequired(on: boolean): Promise<void> {
  await setPlatformConfig(CREDIT_KEYS.required, on ? 'on' : 'off', false);
}

/** Minutes of grace on top of a balance. Whole minutes, rounded up — 10% of 145 is 15, not 14.5. */
export function toleranceMinutes(balanceMinutes: number): number {
  return Math.ceil(Math.max(0, balanceMinutes) * CREDIT_TOLERANCE);
}

/** Everything a balance may be spoken against: the minutes bought, plus the tolerance. */
export function allowanceMinutes(balanceMinutes: number): number {
  const balance = Math.max(0, balanceMinutes);
  return balance + toleranceMinutes(balance);
}

export type CreditVerdict = {
  /** False only when the gate is armed and the allowance is spent. */
  allowed: boolean;
  /** Whether the gate is armed at all. False = this org is not credit-gated. */
  required: boolean;
  balanceMinutes: number;
  usedMinutes: number;
  /** Credits left before the tolerance is touched. 0 once they are out. */
  remainingMinutes: number;
  toleranceMinutes: number;
  allowanceMinutes: number;
};

/**
 * Can this org still be spoken to?
 *
 * Takes `usedMinutes` from the caller rather than aggregating again: the plan
 * check has already counted this month's minutes, and counting them twice on
 * every inbound call would double the cost of answering the phone.
 *
 * Only wallet orgs are gated. A legacy monthly plan sold an included allowance,
 * and stopping those clinics for want of credits they were never asked to buy
 * would be breaking a deal they are still paying for — unless they have since
 * been moved onto the wallet, which `billingModel` is how anyone says so.
 */
export async function checkCallCredits(args: {
  orgId: string;
  usageBased: boolean;
  usedMinutes: number;
}): Promise<CreditVerdict> {
  const org = await prisma.organization.findUnique({
    where: { id: args.orgId },
    select: { prepaidMinutes: true, billingModel: true },
  });
  const balance = Math.max(0, org?.prepaidMinutes ?? 0);
  const used = Math.max(0, args.usedMinutes);
  const tolerance = toleranceMinutes(balance);
  const allowance = balance + tolerance;
  const remaining = Math.max(0, balance - used);

  // Gated because the org is on the wallet — stated on the org, or inferred
  // from a usage-based plan for every account that predates the column. The
  // platform-wide switch still has the last word: arming the gate is one
  // decision, and it is not made per org.
  const required = isPrepaidWallet(org, args.usageBased) && (await creditsRequired());
  const verdict: CreditVerdict = {
    allowed: !required || used < allowance,
    required,
    balanceMinutes: balance,
    usedMinutes: used,
    remainingMinutes: remaining,
    toleranceMinutes: tolerance,
    allowanceMinutes: allowance,
  };

  // The owner hears about it the moment the credits run out — while the
  // tolerance still buys them time — not when the phone has already stopped.
  if (required && remaining <= 0) {
    await alertOwnerCreditsEmpty(args.orgId, verdict).catch((err) =>
      console.error('[credits] could not alert the owner for org', args.orgId, err),
    );
  }

  return verdict;
}

/** What a caller is told when the credits and the tolerance are both spent. */
export function creditsExhaustedMessage(v: CreditVerdict): string {
  if (v.balanceMinutes <= 0) {
    return 'Calls are paused: this account has no prepaid minutes. Buy minutes from Settings → Billing and the line answers again straight away.';
  }
  return `Calls are paused: this account has used all ${v.balanceMinutes.toLocaleString('en-IN')} prepaid minutes, plus the ${v.toleranceMinutes.toLocaleString('en-IN')}-minute tolerance on top. Top up from Settings → Billing and the line answers again straight away.`;
}

/** "YYYY-MM" in UTC, matching the month the sweep bills on. */
function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Email the owner, once per calendar month.
 *
 * The claim is an atomic conditional update rather than a read-then-write: this
 * runs on the call path, so two calls landing together would otherwise each see
 * "not yet alerted" and each send. Whichever update matches a row is the one
 * that sends; the other gets count 0 and does nothing.
 *
 * The send is awaited, which costs one slow call answer per org per month —
 * paid once, not per call — and in exchange the email cannot be lost to a
 * request being torn down before a floating promise resolved.
 */
async function alertOwnerCreditsEmpty(orgId: string, verdict: CreditVerdict): Promise<void> {
  const month = currentMonth();
  const claim = await prisma.organization.updateMany({
    where: { id: orgId, OR: [{ creditAlertMonth: null }, { creditAlertMonth: { not: month } }] },
    data: { creditAlertMonth: month },
  });
  if (claim.count === 0) return;

  const [org, owner] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.membership.findFirst({
      where: { orgId, role: 'OWNER' },
      select: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const to = owner?.user?.email;
  if (!to) {
    console.error('[credits] org', orgId, 'is out of minutes and has no owner to tell');
    return;
  }

  const mail = creditsEmptyEmail({
    name: owner.user?.name ?? null,
    orgName: org?.name ?? 'your practice',
    balanceMinutes: verdict.balanceMinutes,
    toleranceMinutes: verdict.toleranceMinutes,
    baseUrl: process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '',
  });
  await sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
}
