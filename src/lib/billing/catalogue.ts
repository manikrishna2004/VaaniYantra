import { prisma } from '@/lib/db';
import { getPlanOverrides } from '@/lib/platform';
import { checkCallCredits, creditsExhaustedMessage, type CreditVerdict } from '@/lib/billing/credits';
import { billableMinutes, periodFor } from '@/lib/usage/minutes';

// Phase 7 — Billing & Subscriptions. Plans are defined in code (a catalogue),
// the org carries a `plan` key, and usage is metered from existing data. Actual
// payment collection (Stripe) is a later batch; this gives plans, limits, usage
// visibility, and limit enforcement.

// ── ONE RATE, NO PLANS ──────────────────────────────────────────────────────
//
// The tiered catalogue below is retired. Everything is now sold at a single
// per-minute rate — ₹5/min, or ₹4.5/min at volume — billed monthly for the
// minutes actually spoken. There is no monthly fee, no included bundle, and
// nothing to choose.
//
// The old plans are still HERE, and still resolve, because live organisations
// hold those keys, Cashfree order tags carry them and issued invoices are
// stamped with them. Every one is marked `legacy`, which means holdable but
// never sellable: an existing clinic keeps the plan and the price it signed up
// on until it is moved across by hand, and nobody new can land on one.
//
// `product` survives as a label on those legacy rows. Nothing is segmented by
// it any more.
export type PlanProduct = 'bundle' | 'voice' | 'chat';

export type PlanKey =
  // The two live rates. `standard` is what every new organisation gets;
  // `scale` is the volume rate, assigned from /admin once it is agreed.
  | 'standard'
  | 'scale'
  // Legacy keys. Live orgs hold these, Cashfree order tags carry them, and
  // invoices are stamped with them, so they can never be renamed or removed —
  // only hidden from the pricing page (see `legacy`).
  | 'free'
  | 'starter'
  | 'growth'
  | 'pro'
  | 'business'
  | 'enterprise'
  // Voice agents + patient chatbot.
  | 'bundle_clinic'
  | 'bundle_practice'
  | 'bundle_hospital'
  // Voice agents only.
  | 'voice_starter'
  | 'voice_growth'
  | 'voice_pro'
  // Patient chatbot only.
  | 'chat_starter'
  | 'chat_growth'
  | 'chat_pro';

export type PlanLimits = {
  agents: number;
  workspaces: number;
  callMinutesPerMonth: number;
  knowledgeDocs: number;
  // How many patient chatbots the clinic can create. 0 on a voice-only plan —
  // that is what makes it voice-only.
  chatbots: number;
  // Distinct patients who may chat in a calendar month. 0 on voice-only.
  chatConversationsPerMonth: number;
};

export type Plan = {
  key: PlanKey;
  name: string;
  // Which product line this belongs to, for the segmented pricing page.
  product: PlanProduct;
  // Holdable but not buyable: still resolves for orgs already on it (limits,
  // billing page, invoices) but never offered for purchase. This is how the
  // catalogue was restructured without repricing or migrating a single live org.
  legacy?: boolean;
  priceMonthly: number; // INR ₹ (ignored when contactSales)
  // Enterprise has no public price — "talk with us" / contact sales.
  contactSales?: boolean;
  // Pay-as-you-go. There is no included allowance and no monthly fee: every
  // minute is billed at `pricePerMinute` in the monthly sweep, and
  // `limits.callMinutesPerMonth` stops meaning "what you bought" and starts
  // meaning "the runaway-usage cap". The two live rates set this; every legacy
  // plan leaves it off and keeps the old included-minutes-plus-overage maths.
  usageBased?: boolean;
  // Rate-led pricing: the headline ₹/min cost of the plan. On a usage-based
  // plan this IS the price. On the legacy plans included minutes were derived
  // from it (priceMonthly ÷ pricePerMinute); absent on Free (no per-min
  // framing), on chatbot-only plans (no calls), and on Enterprise (custom).
  pricePerMinute?: number;
  // ₹ per minute past the included allowance (billed monthly). Absent = no
  // overage: calls hard-block at the limit (Free, and every chat-only plan).
  overagePerMinute?: number;
  limits: PlanLimits;
  features: string[];
};

// How far past the included minutes overage may run before calls block anyway
// (safety net against runaway usage / uncollectable bills): included × this.
// Legacy plans only — a usage-based plan bills every minute, so its
// callMinutesPerMonth is already the cap.
export const OVERAGE_CAP_MULTIPLIER = 2;

// ── The rate ────────────────────────────────────────────────────────────────
//
// One number on the website, in the product, and in the monthly sweep. Quote it
// from here rather than typing "5" into a page — a rate that lives in two
// places is a rate that will be wrong in one of them.
export const RATE_PER_MINUTE_INR = 5;
// The volume rate. Deliberately not a public tier with a minutes threshold
// attached: it is agreed in a conversation and then applied by moving the org
// onto the `scale` key from /admin.
export const SCALE_RATE_PER_MINUTE_INR = 4.5;

// The plan every new organisation is created on. Sign-up is invite-only, so an
// account existing at all means we decided to serve it — starting it on the
// paid rate rather than a trial is the honest default, and it is what makes the
// monthly sweep bill an invited clinic for the minutes it actually used.
export const DEFAULT_NEW_ORG_PLAN: PlanKey = 'standard';

// A safety cap, not an allowance: minutes past this stop new calls, so a stuck
// loop or a rogue campaign cannot run up a bill nobody can pay. ~₹1.75L of talk
// time — far past anything a real clinic reaches by accident.
const STANDARD_MONTHLY_MINUTE_CAP = 50_000;

// `Infinity` = unlimited. Values are starting points — fully editable from the
// Admin dashboard (price + every limit). Prices are in INR (₹) per month.
//
// The legacy plans below are frozen deliberately: their numbers are asserted by
// tests and, more importantly, held by live orgs. Repricing them would silently
// change what an existing clinic is charged.
export const PLANS: Record<PlanKey, Plan> = {
  // ── The live rates. Everything below these is retired. ────────────────────
  standard: {
    key: 'standard',
    name: 'Standard',
    product: 'bundle',
    priceMonthly: 0,
    usageBased: true,
    pricePerMinute: RATE_PER_MINUTE_INR,
    // Same number as the rate, and it has to be: the monthly sweep only looks
    // at plans with an overage rate, and it bills at this one. Leaving it off
    // would make the whole account free by accident.
    overagePerMinute: RATE_PER_MINUTE_INR,
    limits: {
      agents: Infinity,
      workspaces: Infinity,
      // The only finite limit, and it is a runaway-usage stop rather than
      // something the clinic bought.
      callMinutesPerMonth: STANDARD_MONTHLY_MINUTE_CAP,
      knowledgeDocs: Infinity,
      chatbots: Infinity,
      chatConversationsPerMonth: Infinity,
    },
    features: [
      'Every feature — voice agents and the patient chatbot',
      'Billed monthly for the minutes you actually use',
      'No monthly fee, no minimum, cancel anytime',
    ],
  },
  scale: {
    key: 'scale',
    name: 'Scale',
    product: 'bundle',
    priceMonthly: 0,
    usageBased: true,
    pricePerMinute: SCALE_RATE_PER_MINUTE_INR,
    overagePerMinute: SCALE_RATE_PER_MINUTE_INR,
    limits: {
      agents: Infinity,
      workspaces: Infinity,
      // Uncapped: this rate is only ever set by hand, on an account we have
      // already talked to, so an automatic ceiling would be us guessing at a
      // volume they told us about.
      callMinutesPerMonth: Infinity,
      knowledgeDocs: Infinity,
      chatbots: Infinity,
      chatConversationsPerMonth: Infinity,
    },
    features: [
      'Everything in Standard',
      'For multi-branch groups and hospitals at volume',
      'Agreed with us — not a tier you pick',
    ],
  },

  // ── Retired. Holdable by the orgs already on them, never sold again. ──────
  free: {
    key: 'free',
    name: 'Free',
    legacy: true,
    product: 'bundle',
    priceMonthly: 0,
    limits: { agents: 1, workspaces: 1, callMinutesPerMonth: 15, knowledgeDocs: 3, chatbots: 1, chatConversationsPerMonth: 50 },
    features: ['1 AI agent', 'Inbound & outbound calls', 'Try the patient chatbot'],
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    legacy: true,
    product: 'bundle',
    priceMonthly: 0,
    contactSales: true,
    limits: {
      agents: Infinity,
      workspaces: Infinity,
      callMinutesPerMonth: Infinity,
      knowledgeDocs: Infinity,
      chatbots: Infinity,
      chatConversationsPerMonth: Infinity,
    },
    features: ['As low as ₹3.5/min at volume', 'Multi-branch & multi-department', 'White-label, SSO & SLA'],
  },

  // ── Bundle: voice agents + patient chatbot ────────────────────────────────
  bundle_clinic: {
    key: 'bundle_clinic',
    name: 'Clinic',
    legacy: true,
    product: 'bundle',
    priceMonthly: 2999,
    pricePerMinute: 6.3,
    overagePerMinute: 7,
    limits: { agents: 10, workspaces: 5, callMinutesPerMonth: 475, knowledgeDocs: 100, chatbots: 1, chatConversationsPerMonth: 1000 },
    features: ['Patient chatbot included', 'Per-doctor calendars', 'SMS confirmations & reminders'],
  },
  bundle_practice: {
    key: 'bundle_practice',
    name: 'Practice',
    legacy: true,
    product: 'bundle',
    priceMonthly: 7999,
    pricePerMinute: 5.5,
    overagePerMinute: 6,
    limits: { agents: 25, workspaces: 10, callMinutesPerMonth: 1450, knowledgeDocs: 300, chatbots: 2, chatConversationsPerMonth: 3000 },
    features: ['Everything in Clinic', 'HubSpot CRM & public API', 'Priority routing'],
  },
  bundle_hospital: {
    key: 'bundle_hospital',
    name: 'Hospital',
    legacy: true,
    product: 'bundle',
    priceMonthly: 19999,
    pricePerMinute: 4.7,
    overagePerMinute: 5,
    limits: { agents: 75, workspaces: 25, callMinutesPerMonth: 4250, knowledgeDocs: 1000, chatbots: 5, chatConversationsPerMonth: 8000 },
    features: ['Everything in Practice', 'Department routing', 'Advanced analytics & dedicated support'],
  },

  // ── Voice agents only ─────────────────────────────────────────────────────
  voice_starter: {
    key: 'voice_starter',
    name: 'Voice Starter',
    legacy: true,
    product: 'voice',
    priceMonthly: 999,
    pricePerMinute: 7,
    overagePerMinute: 8,
    limits: { agents: 3, workspaces: 2, callMinutesPerMonth: 143, knowledgeDocs: 25, chatbots: 0, chatConversationsPerMonth: 0 },
    features: ['AI receptionist on your number', 'Books on Google Calendar', 'SMS confirmations'],
  },
  voice_growth: {
    key: 'voice_growth',
    name: 'Voice Growth',
    legacy: true,
    product: 'voice',
    priceMonthly: 2499,
    pricePerMinute: 6.3,
    overagePerMinute: 7,
    limits: { agents: 10, workspaces: 5, callMinutesPerMonth: 400, knowledgeDocs: 100, chatbots: 0, chatConversationsPerMonth: 0 },
    features: ['Everything in Voice Starter', 'Per-doctor calendars', 'HubSpot CRM & public API'],
  },
  voice_pro: {
    key: 'voice_pro',
    name: 'Voice Pro',
    legacy: true,
    product: 'voice',
    priceMonthly: 6999,
    pricePerMinute: 5.5,
    overagePerMinute: 6,
    limits: { agents: 25, workspaces: 10, callMinutesPerMonth: 1270, knowledgeDocs: 300, chatbots: 0, chatConversationsPerMonth: 0 },
    features: ['Everything in Voice Growth', 'Priority routing', 'Higher concurrency'],
  },

  // ── Patient chatbot only ──────────────────────────────────────────────────
  // No call minutes AND no overage rate: absent overage is what makes the limit
  // a hard block rather than a billable overrun (same rule as Free).
  chat_starter: {
    key: 'chat_starter',
    name: 'Chatbot Starter',
    legacy: true,
    product: 'chat',
    priceMonthly: 799,
    limits: { agents: 1, workspaces: 1, callMinutesPerMonth: 0, knowledgeDocs: 25, chatbots: 1, chatConversationsPerMonth: 500 },
    features: ['1 patient chatbot', 'Prescriptions & reports in chat', 'Phone + OTP patient sign-in'],
  },
  chat_growth: {
    key: 'chat_growth',
    name: 'Chatbot Growth',
    legacy: true,
    product: 'chat',
    priceMonthly: 1999,
    limits: { agents: 2, workspaces: 2, callMinutesPerMonth: 0, knowledgeDocs: 100, chatbots: 2, chatConversationsPerMonth: 2000 },
    features: ['Everything in Chatbot Starter', 'Patients can book & reschedule', 'Public API access'],
  },
  chat_pro: {
    key: 'chat_pro',
    name: 'Chatbot Pro',
    legacy: true,
    product: 'chat',
    priceMonthly: 4999,
    limits: { agents: 5, workspaces: 5, callMinutesPerMonth: 0, knowledgeDocs: 300, chatbots: 5, chatConversationsPerMonth: 6000 },
    features: ['Everything in Chatbot Growth', 'One chatbot per branch', 'Advanced analytics'],
  },

  // ── Legacy (pre-product-line). Holdable, not buyable. ─────────────────────
  // Chatbot limits are set generously: enforcement is create-time only, so a
  // legacy org keeps everything it already has either way, and these numbers
  // just decide what it may still add.
  starter: {
    key: 'starter',
    name: 'Starter',
    product: 'bundle',
    legacy: true,
    priceMonthly: 999,
    pricePerMinute: 7,
    overagePerMinute: 8,
    limits: { agents: 3, workspaces: 2, callMinutesPerMonth: 143, knowledgeDocs: 25, chatbots: 1, chatConversationsPerMonth: 500 },
    features: ['Everything in Free', 'Connectors & webhooks', 'SMS confirmations'],
  },
  growth: {
    key: 'growth',
    name: 'Growth',
    product: 'bundle',
    legacy: true,
    priceMonthly: 2999,
    pricePerMinute: 6.3,
    overagePerMinute: 7,
    limits: { agents: 10, workspaces: 5, callMinutesPerMonth: 475, knowledgeDocs: 100, chatbots: 2, chatConversationsPerMonth: 2000 },
    features: ['Everything in Starter', 'HubSpot CRM', 'Public API access'],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    product: 'bundle',
    legacy: true,
    priceMonthly: 7999,
    pricePerMinute: 5.5,
    overagePerMinute: 6,
    limits: { agents: 25, workspaces: 10, callMinutesPerMonth: 1450, knowledgeDocs: 300, chatbots: 3, chatConversationsPerMonth: 4000 },
    features: ['Everything in Growth', 'Priority routing', 'Higher concurrency'],
  },
  business: {
    key: 'business',
    name: 'Business',
    product: 'bundle',
    legacy: true,
    priceMonthly: 19999,
    pricePerMinute: 4.7,
    overagePerMinute: 5,
    limits: { agents: 75, workspaces: 25, callMinutesPerMonth: 4250, knowledgeDocs: 1000, chatbots: 5, chatConversationsPerMonth: 8000 },
    features: ['Everything in Pro', 'Advanced analytics', 'Dedicated support'],
  },
};

// Display order: the two live rates first, then everything retired, in the
// order it was retired in. Nothing filters this by product line any more.
export const PLAN_ORDER: PlanKey[] = [
  'standard',
  'scale',
  'free',
  'bundle_clinic',
  'bundle_practice',
  'bundle_hospital',
  'voice_starter',
  'voice_growth',
  'voice_pro',
  'chat_starter',
  'chat_growth',
  'chat_pro',
  'enterprise',
  // Legacy, kept at the end so anything iterating the catalogue still sees them.
  'starter',
  'growth',
  'pro',
  'business',
];

/** The rates on offer today, in display order. */
export function livePlans(plans: Plan[]): Plan[] {
  return plans.filter((p) => p.usageBased && !p.legacy);
}

/**
 * Plans a clinic can buy self-serve — nothing, now.
 *
 * Left in place rather than deleted: it is the single rule four routes ask
 * before taking money, and with every plan either retired or usage-based it
 * correctly answers "no" everywhere at once. Selling a monthly plan again is
 * then a matter of un-retiring one, not of re-finding those four routes.
 */
export function isBuyable(plan: Plan): boolean {
  return !plan.legacy && !plan.contactSales && !plan.usageBased && plan.priceMonthly > 0;
}

/**
 * Whether this plan key can go through checkout, as a message or null.
 *
 * Derived from the catalogue rather than a hardcoded "not free, not
 * enterprise" list, which used to be repeated across four routes (one of them
 * naming the plans in its error text) and would have had to be edited in all
 * four every time the catalogue changed.
 */
export async function checkoutPlanError(key: string | null | undefined): Promise<string | null> {
  if (!isPlanKey(key)) return 'That plan does not exist.';
  const plan = await getEffectivePlan(key);
  // Legacy plans stay holdable — an org already on one keeps its price and its
  // renewals — but nobody new can buy into a plan we no longer sell.
  if (plan.legacy) return `The ${plan.name} plan is no longer sold.`;
  // Nothing is bought up front any more: usage is billed at the end of the
  // month for the minutes that actually happened, so there is no checkout to
  // send anyone to.
  if (plan.usageBased)
    return `${plan.name} is billed monthly for the minutes you use — there is nothing to pay up front.`;
  if (plan.contactSales) return `${plan.name} is arranged with us directly — write to info@vaaniyantra.com.`;
  if (plan.priceMonthly <= 0) return `The ${plan.name} plan is free and needs no checkout.`;
  return null;
}

export function isPlanKey(v: string | null | undefined): v is PlanKey {
  return v != null && (PLAN_ORDER as string[]).includes(v);
}

// Unknown / legacy values fall back to the Free entry plan.
export function getPlan(key: string | null | undefined): Plan {
  return isPlanKey(key) ? PLANS[key] : PLANS.free;
}

// Plan with founder-set price/limit overrides (admin dashboard) applied.
export async function getEffectivePlan(key: string | null | undefined): Promise<Plan> {
  const base = getPlan(key);
  const overrides = await getPlanOverrides().catch(() => ({}) as Awaited<ReturnType<typeof getPlanOverrides>>);
  const o = overrides[base.key];
  if (!o) return base;
  const pricePerMinute = o.pricePerMinute ?? base.pricePerMinute;
  return {
    ...base,
    priceMonthly: o.priceMonthly ?? base.priceMonthly,
    pricePerMinute,
    // On a usage plan the two are the same number by construction — the rate IS
    // what every minute bills at. So a founder who edits only the rate in
    // /admin must not be left with a page quoting one figure and a sweep
    // charging another; the overage field only wins here if it was overridden
    // deliberately.
    overagePerMinute:
      o.overagePerMinute ?? (base.usageBased ? pricePerMinute : base.overagePerMinute),
    limits: { ...base.limits, ...(o.limits ?? {}) },
  };
}

export async function getEffectivePlans(): Promise<Plan[]> {
  return Promise.all(PLAN_ORDER.map((k) => getEffectivePlan(k)));
}

export type Usage = {
  agents: number;
  workspaces: number;
  callMinutes: number; // current calendar month
  knowledgeDocs: number;
  chatbots: number;
  chatConversations: number; // distinct patients who chatted this month
};

export function monthStart(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Distinct patients who used a chatbot this calendar month.
 *
 * Counted per patient rather than per message: it is what a clinic can reason
 * about ("500 patients a month"), and it means a patient asking six follow-up
 * questions is not punished for it.
 */
export async function countChatConversations(orgId: string): Promise<number> {
  const rows = await prisma.portalChatTurn.groupBy({
    by: ['contactId'],
    where: { portal: { orgId }, createdAt: { gte: monthStart() } },
  });
  return rows.length;
}

// Meter an org's usage. Counts come from the tables that own them; MINUTES go
// through billableMinutes, which is the one place that decides whether an org
// is metered from Call.durationSec or from the usage ledger. Everything else
// here is a count of things we hold, and has no second source.
export async function getUsage(orgId: string): Promise<Usage> {
  const where = { workspace: { orgId } };
  const [agents, workspaces, knowledgeDocs, callMinutes, chatbots, chatConversations] = await Promise.all([
    prisma.agent.count({ where }),
    prisma.workspace.count({ where: { orgId } }),
    prisma.document.count({ where }),
    billableMinutes(orgId, periodFor()),
    prisma.portal.count({ where: { orgId } }),
    countChatConversations(orgId),
  ]);
  return { agents, workspaces, knowledgeDocs, chatbots, chatConversations, callMinutes };
}

export type CreatableResource = 'agents' | 'workspaces' | 'knowledgeDocs' | 'chatbots';

// Whether the org can create another of `resource` under its plan. Returns the
// limit + current count so callers can craft a helpful message.
export async function checkCreateAllowed(
  orgId: string,
  resource: CreatableResource,
): Promise<{ allowed: boolean; limit: number; current: number; plan: Plan }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const plan = await getEffectivePlan(org?.plan);
  const limit = plan.limits[resource];
  if (!Number.isFinite(limit)) return { allowed: true, limit, current: 0, plan };

  let current: number;
  const where = { workspace: { orgId } };
  if (resource === 'workspaces') current = await prisma.workspace.count({ where: { orgId } });
  else if (resource === 'agents') current = await prisma.agent.count({ where });
  else if (resource === 'chatbots') current = await prisma.portal.count({ where: { orgId } });
  else current = await prisma.document.count({ where });

  return { allowed: current < limit, limit, current, plan };
}

const RESOURCE_NOUNS: Record<CreatableResource, string> = {
  agents: 'agents',
  workspaces: 'workspaces',
  knowledgeDocs: 'knowledge documents',
  chatbots: 'patient chatbots',
};

// A 403 message for an exceeded limit.
export function limitMessage(resource: CreatableResource, limit: number, plan: Plan): string {
  // A zero limit is not "you've used them all", it's "this plan doesn't include
  // the thing" — saying "allows up to 0 patient chatbots" reads like a bug.
  if (limit === 0) {
    return resource === 'chatbots'
      ? `The ${plan.name} plan is voice agents only. Switch to a Voice + Chatbot or Chatbot plan to give your patients a chatbot.`
      : `Your ${plan.name} plan does not include ${RESOURCE_NOUNS[resource]}. Upgrade your plan to add them.`;
  }
  return `Your ${plan.name} plan allows up to ${limit} ${RESOURCE_NOUNS[resource]}. Upgrade your plan to add more.`;
}

/**
 * Whether a patient may start a chatbot conversation this month.
 *
 * Only counts when this patient has not chatted yet this month: the groupBy is
 * too expensive to run on every message, and a patient already inside their
 * conversation must never be cut off mid-sentence by a quota.
 */
export async function checkChatAllowed(
  orgId: string,
  contactId: string,
): Promise<{ allowed: boolean; limit: number; used: number; plan: Plan }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const plan = await getEffectivePlan(org?.plan);
  const limit = plan.limits.chatConversationsPerMonth;
  if (!Number.isFinite(limit)) return { allowed: true, limit, used: 0, plan };

  const already = await prisma.portalChatTurn.findFirst({
    where: { contactId, portal: { orgId }, createdAt: { gte: monthStart() } },
    select: { id: true },
  });
  if (already) return { allowed: true, limit, used: 0, plan };

  const used = await countChatConversations(orgId);
  return { allowed: used < limit, limit, used, plan };
}

// Whether the org can place another call this month under its call-minute
// allowance. Metered, not countable, so it has its own check, enforced at
// call-placement time (an in-progress call may push usage slightly past the
// boundary, but no new calls start once it is reached).
//
// Plans with an overage rate keep going past the included minutes — extra
// minutes bill at `overagePerMinute` (monthly sweep) — up to a hard safety cap
// of included × OVERAGE_CAP_MULTIPLIER. Plans without one (Free, and every
// chatbot-only plan) block at the included limit.
//
// A chatbot-only plan has callMinutesPerMonth: 0 and no overage rate, so the
// cap is 0 and `used < 0` is false from the first call. That is exactly what
// makes it chatbot-only — no separate switch to keep in sync.
export async function checkCallMinutesAllowed(
  orgId: string,
): Promise<{
  allowed: boolean;
  limit: number;
  used: number;
  inOverage: boolean;
  plan: Plan;
  credits: CreditVerdict;
}> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const plan = await getEffectivePlan(org?.plan);
  const limit = plan.limits.callMinutesPerMonth;

  // This month's minutes are counted for BOTH gates — the plan's safety cap and
  // the prepaid credit balance — so an uncapped plan can no longer skip the
  // count. Returning early on `!Number.isFinite(limit)` would have exempted the
  // volume rate, the one plan most likely to be running on bought credits, from
  // the credit gate entirely.
  //
  // Metered through billableMinutes so an org served by a reseller is gated on
  // the minutes it actually spoke, not on the rows that happen to be in our own
  // calls table. This is the hot path — it runs on every inbound call — and the
  // ledger read is a single index-only scan, cheaper than the join through
  // workspace it replaces.
  const used = await billableMinutes(orgId, periodFor());

  // Prepaid minutes, plus the tolerance past them. Off unless the platform has
  // armed the gate, in which case this is what actually stops the calls.
  const credits = await checkCallCredits({
    orgId,
    usageBased: plan.usageBased ?? false,
    usedMinutes: used,
  });

  if (!Number.isFinite(limit)) {
    return { allowed: credits.allowed, limit, used, inOverage: false, plan, credits };
  }
  // On a usage-based plan the limit IS the cap — there is no included allowance
  // to run past, so doubling it would silently double the runaway-usage ceiling
  // the number was chosen to be. And nothing is ever "in overage": every minute
  // bills at the same rate, so the banner that word drives would be permanent
  // and meaningless.
  const cap = plan.usageBased
    ? limit
    : plan.overagePerMinute
      ? limit * OVERAGE_CAP_MULTIPLIER
      : limit;
  return {
    allowed: used < cap && credits.allowed,
    limit,
    used,
    inOverage: !plan.usageBased && used >= limit,
    plan,
    credits,
  };
}

// A 403 message for an exhausted call-minute allowance (or overage cap).
export function callMinutesLimitMessage(
  limit: number,
  used: number,
  plan: Plan,
  credits?: CreditVerdict,
): string {
  // Out of credits is a different problem from hitting a cap, and it has a
  // different fix — buy minutes, not "write to us". Checked first so the safety
  // cap's wording never lands on a clinic that simply needs to top up.
  if (credits && !credits.allowed) return creditsExhaustedMessage(credits);
  // Hitting the cap on a pay-as-you-go account is not "you need a bigger plan"
  // — there isn't one. It is a safety stop, and the only honest thing to say is
  // that we will lift it.
  if (plan.usageBased) {
    return `Calls are paused: this account has used ${used.toLocaleString()} minutes this month, which reaches the ${limit.toLocaleString()}-minute safety cap. Write to info@vaaniyantra.com and we will lift it straight away.`;
  }
  if (limit === 0) {
    return `The ${plan.name} plan is the patient chatbot only — it does not include AI phone calls. Switch to a Voice or Voice + Chatbot plan to start answering calls.`;
  }
  if (plan.overagePerMinute) {
    return `Your ${plan.name} plan includes ${limit.toLocaleString()} call minutes per month plus overage up to ${(limit * OVERAGE_CAP_MULTIPLIER).toLocaleString()} minutes, and you have used ${used.toLocaleString()}. Upgrade your plan to place more calls.`;
  }
  return `Your ${plan.name} plan includes ${limit.toLocaleString()} call minutes per month and you have used ${used.toLocaleString()}. Upgrade your plan to place more calls.`;
}

// ── The four numbers that decide a call-minute charge ───────────────────────
//
// Pulled out of `Plan` so the same arithmetic can price a per-client rate card,
// which is not a plan and must never become one (see src/lib/billing/rate-card.ts).
// Deliberately structural and deliberately optional-shaped: it mirrors the plan
// fields exactly, including which of them may be absent, so that pricing off a
// plan and pricing off a card cannot drift into two different sets of rules.
export type BillableRate = {
  usageBased?: boolean;
  pricePerMinute?: number;
  overagePerMinute?: number;
  /** The included allowance. `Infinity` when there is none. */
  includedMinutes: number;
};

/** The four numbers a plan contributes, unchanged. */
export function rateFromPlan(plan: Plan): BillableRate {
  return {
    usageBased: plan.usageBased,
    pricePerMinute: plan.pricePerMinute,
    overagePerMinute: plan.overagePerMinute,
    includedMinutes: plan.limits.callMinutesPerMonth,
  };
}

// What a month's minutes cost at a rate — the plan's or a client's card.
//
// This is `overageFor`'s body, moved verbatim: the same branches, the same
// `??` fallbacks, the same rounding, in the same order. It is the function that
// decides what every live org is charged and its tests are the ones that would
// notice a difference, so it was carried across rather than rewritten.
export function overageForRate(
  rate: BillableRate,
  usedMinutes: number,
): { minutes: number; amountInr: number } {
  // Pay-as-you-go: every minute is billable, so this is the whole bill rather
  // than the tail of one. Checked BEFORE the Number.isFinite guard below on
  // purpose — the Scale rate is deliberately uncapped, and falling into that
  // guard would bill our largest customers nothing at all.
  if (rate.usageBased) {
    const perMinute = rate.pricePerMinute ?? rate.overagePerMinute ?? 0;
    const minutes = Math.max(0, usedMinutes);
    return { minutes, amountInr: Math.round(minutes * perMinute * 100) / 100 };
  }
  const limit = rate.includedMinutes;
  if (!rate.overagePerMinute || !Number.isFinite(limit)) return { minutes: 0, amountInr: 0 };
  const minutes = Math.max(0, usedMinutes - limit);
  return { minutes, amountInr: Math.round(minutes * rate.overagePerMinute * 100) / 100 };
}

// Overage state for the current month: minutes past the included allowance and
// what they will cost at the plan's overage rate (0s when not applicable).
export function overageFor(plan: Plan, usedMinutes: number): { minutes: number; amountInr: number } {
  return overageForRate(rateFromPlan(plan), usedMinutes);
}
