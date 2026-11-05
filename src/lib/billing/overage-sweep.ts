import { prisma } from '@/lib/db';
import { planAt, seedPlanHistory } from '@/lib/plan-history';
import { secretMatches } from '@/lib/cron-auth';
import { getWhatsappChatAddonPrice } from '@/lib/platform';
import { whatsappEnabled } from '@/lib/flags';
import { overageForRate, PLANS, PLAN_ORDER } from '@/lib/billing/catalogue';
import { rateFor, isBillableRate } from '@/lib/billing/rate-card';
import { settlePrepaidOnly, splitAgainstBalance, prepaidRateForMinutes } from '@/lib/billing/prepaid';
import { billableMinutes } from '@/lib/usage/minutes';
import { lockBillingPeriod } from '@/lib/usage/period';
import { readyToCloseMonth } from '@/lib/usage/omni-reconcile';
import { getCashfreeConfig, isCashfreeConfigured, checkoutMode, chargeSubscription } from '@/lib/cashfree';

// Monthly overage sweep: for every org, compute last month's call minutes past
// the plan allowance and raise the charge on the org's Cashfree mandate. Orgs
// without an active mandate get a `manual` record for offline invoicing.
// Idempotent — one OverageCharge per org per month — so it can be run any
// number of times (admin button and/or cron).
//
// Unlike the PayU engine this replaces, there is no pre-debit notice to send
// and no second pass: Cashfree takes the charge with a schedule date and
// handles the RBI notification itself. The charge lands as `charged` here and
// the webhook flips it to `paid` (or `failed`) when it settles.
//
// While the platform is on Payment Gateway only — Subscriptions not activated —
// no org has a mandate, so every charge is `manual` by design.

export type SweepEntry = {
  org: string;
  minutes: number;
  amountInr: number;
  status: string;
  /** Minutes of this month that the org's prepaid balance absorbed. */
  prepaidMinutes?: number;
  /** Set when the month was priced from a client rate card rather than the catalogue. */
  rateCardId?: string;
};

/** Overage charges are scheduled this far out, giving Cashfree room to notify. */
export const CHARGE_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Resolve which billing month to sweep. `requested` must be "YYYY-MM" (else
 * it's ignored and the previous UTC month is used). The month must have ended.
 */
export function resolveSweepMonth(
  requested: string | undefined,
  now: Date = new Date(),
): { month: string; from: Date; to: Date; error?: never } | { error: string } {
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested ?? '') ? requested! : null;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = valid ?? `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  if (to > now) return { error: `Month ${month} has not ended yet.` };
  return { month, from, to };
}

/**
 * True when `provided` (the value after "Bearer ") matches OVERAGE_CRON_SECRET.
 * Always false when the secret isn't configured — the cron path is opt-in.
 */
export function cronSecretMatches(provided: string | null | undefined): boolean {
  return secretMatches(provided, process.env.OVERAGE_CRON_SECRET);
}

export async function runOverageSweep(month: string, from: Date, to: Date): Promise<SweepEntry[]> {
  const cfg = await getCashfreeConfig();
  // Only a live mandate can be charged; a one-time-order platform has nothing
  // to debit against, so those orgs fall through to manual invoicing.
  const canCharge = isCashfreeConfigured(cfg) && checkoutMode(cfg) === 'subscription';

  // The WhatsApp chat add-on can't deliver while the feature flag is off, so it
  // must not be billed either.
  const addonPrice = whatsappEnabled() ? await getWhatsappChatAddonPrice() : 0;

  // Only plans that actually have an overage rate can produce an overage
  // charge. Derived from the catalogue rather than a "not free, not
  // enterprise" exclusion list: an allowlist means a new plan is never swept by
  // accident, and it correctly skips the chatbot-only plans, which have no
  // call minutes to run over in the first place.
  //
  // ⚠ It is only the answer for an org with NO rate card. As a filter on its
  // own it was a landmine: an org holding a legacy `free` or `chat_*` key that
  // has since been SOLD a card is not in this list, so it would have been
  // skipped here and never billed — silently, month after month, which is the
  // exact shape of the downgrade bug plan-history.ts was written to fix. A
  // carded org is decided by its card (`isBillableRate`) instead.
  const billableKeys = PLAN_ORDER.filter((k) => (PLANS[k].overagePerMinute ?? 0) > 0);

  // Every org, not just those on a billable plan TODAY. Filtering here on the
  // live `plan` column is what let a downgrade erase a month: an org that spent
  // all of July on voice_starter and moved to free on 1 August simply vanished
  // from this query, and its July overage was never billed. Which plan applies
  // is decided per-org below, from history, against the month being swept.
  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      name: true,
      plan: true,
      prepaidMinutes: true,
      cashfreeSubscriptionId: true,
      subscriptionStatus: true,
      whatsappChatAddon: true,
    },
  });

  const results: SweepEntry[] = [];
  for (const org of orgs) {
    // A cheap pre-check outside the transaction, so a re-run of the sweep skips
    // settled orgs without taking a lock for each. It is NOT the guard that
    // matters — that one is inside the transaction below, under the lock.
    const existing = await prisma.overageCharge.findUnique({
      where: { orgId_month: { orgId: org.id, month } },
    });
    if (existing) {
      results.push({ org: org.name, minutes: existing.minutes, amountInr: existing.amountInr, status: `already ${existing.status}` });
      continue;
    }

    // The plan in force at the END of the swept month, which is the one the
    // month was sold under. A change made after `to` — the downgrade on the 1st
    // — is correctly ignored, because it did not apply to this month.
    await seedPlanHistory(org.id, org.plan);
    const asOf = new Date(to.getTime() - 1);
    const planKey = (await planAt(org.id, asOf)) ?? org.plan;

    // What this client paid THEN — the card in force at the end of the swept
    // month, over the plan they held during it. Dated for the same reason
    // planAt is: a card agreed on the 1st must not reprice the month that
    // ended the day before.
    const rate = await rateFor(org.id, asOf, { planKey });

    // A card says what is billable; without one, the catalogue does.
    const billable =
      rate.source === 'card'
        ? isBillableRate(rate)
        : billableKeys.includes(planKey as (typeof billableKeys)[number]);
    if (!billable) continue;

    // ── Never close a month against an incomplete pull ─────────────────────
    //
    // For an org whose minutes are spoken on a reseller's platform, the month's
    // total is only knowable once that platform has been fully read. Billing
    // half of it is worse than billing it late: OverageCharge is unique per
    // (orgId, month), so the shortfall is PERMANENT — the row exists, the
    // invoice is built from it, and the missing minutes have no way back.
    //
    // So a failed or stale reconciliation blocks the month rather than
    // under-billing it. The sweep is re-runnable and the cron fires twice for
    // exactly this reason.
    const ready = await readyToCloseMonth(org.id, to);
    if (!ready.ready) {
      results.push({
        org: org.name,
        minutes: 0,
        amountInr: 0,
        status: `blocked_unreconciled: ${ready.reason ?? 'usage not reconciled'}`,
      });
      continue;
    }

    // ── Everything that decides and closes the month, in ONE transaction ────
    //
    // The minutes read used to sit out here, before the transaction that writes
    // the OverageCharge. That left a window with teeth once usage can arrive
    // from a source other than our own call handler:
    //
    //   ledger writer  checks "August is open"
    //   sweep          sums August
    //   sweep          writes OverageCharge(org, August)   ← August is closed
    //   ledger writer  inserts an August row               ← never collected
    //
    // Both sides now take the SAME per-org advisory lock (lockBillingPeriod)
    // and hold it across their read AND their write, so the row either lands
    // before the month closes and is billed, or finds the month closed and
    // rolls forward into the next one. It cannot land in between.
    const settled = await prisma.$transaction(async (tx) => {
      await lockBillingPeriod(tx, org.id);

      // Re-check under the lock. Another sweep run — the cron fires twice a
      // month for reboot tolerance — may have closed this month between the
      // pre-check above and this transaction.
      const raced = await tx.overageCharge.findUnique({
        where: { orgId_month: { orgId: org.id, month } },
      });
      if (raced) {
        return { kind: 'already' as const, minutes: raced.minutes, amountInr: raced.amountInr, status: raced.status };
      }

      // Metered through billableMinutes: an org on the ledger is billed for the
      // minutes it actually spoke, wherever they were spoken, and an org still
      // on `calls` gets the identical number it always did.
      const used = await billableMinutes(org.id, { key: month, from, to }, tx);

      // Minutes the org already paid for, up front, come off the top.
      //
      // Only on a per-minute rate: the legacy monthly plans have an included
      // allowance instead, which overageForRate has already subtracted, and
      // applying a prepaid balance on top of that would discount the same
      // minutes twice.
      const prepaid = rate.usageBased
        ? splitAgainstBalance(org.prepaidMinutes ?? 0, used)
        : { covered: 0, billable: used };
      const overage = overageForRate(rate, rate.usageBased ? prepaid.billable : used);

      // A monthly commitment is a FLOOR on the minutes, not an addition to
      // them: a client who agreed ₹20,000 and spoke ₹12,000 owes ₹20,000, not
      // ₹32,000. Applied after the prepaid balance, because minutes already
      // paid for are not minutes owed again — and zero on every org without a
      // card, where minimumInr is 0.
      const usageInr = Math.max(overage.amountInr, rate.minimumInr);

      // Flat monthly add-on fees (currently just the WhatsApp follow-up chat),
      // and the retainer — the agency half of a carded deal, which is owed for
      // the month whether or not anybody picked up the phone.
      const addonInr = org.whatsappChatAddon ? addonPrice : 0;
      const total = Math.round((usageInr + rate.retainerInr + addonInr) * 100) / 100;

      // What the balance this month drew down was SOLD at. Read here, under the
      // lock, in the same transaction that decrements it.
      const prepaidRate = await prepaidRateForMinutes(tx, {
        orgId: org.id,
        minutes: prepaid.covered,
        fallbackRate: rate.pricePerMinute ?? 0,
      });

      // Nothing to bill — but the prepaid minutes this month consumed still have
      // to come off the balance, or a month covered entirely by prepayment would
      // be free twice: once now, and again next month against a balance that was
      // never drawn down. Returning before this was the bug.
      if (total <= 0) {
        if (prepaid.covered > 0) {
          await settlePrepaidOnly(tx, {
            orgId: org.id,
            month,
            minutes: prepaid.covered,
            plan: planKey,
            rateInr: prepaidRate,
          });
          return { kind: 'prepaid' as const, prepaidMinutes: prepaid.covered };
        }
        return { kind: 'nothing' as const };
      }

      const created = await tx.overageCharge.create({
        data: {
          orgId: org.id,
          month,
          minutes: overage.minutes,
          amountInr: total,
          addonInr,
          prepaidMinutes: prepaid.covered,
          prepaidRateInr: prepaidRate,
          plan: planKey,
          status: 'pending',
        },
      });
      if (prepaid.covered > 0) {
        await tx.organization.update({
          where: { id: org.id },
          data: { prepaidMinutes: { decrement: prepaid.covered } },
        });
      }
      return { kind: 'charge' as const, charge: created, total, overage, prepaid };
    });

    if (settled.kind === 'already') {
      results.push({ org: org.name, minutes: settled.minutes, amountInr: settled.amountInr, status: `already ${settled.status}` });
      continue;
    }
    if (settled.kind === 'nothing') continue;
    if (settled.kind === 'prepaid') {
      results.push({
        org: org.name,
        minutes: 0,
        amountInr: 0,
        status: 'covered by prepaid',
        prepaidMinutes: settled.prepaidMinutes,
      });
      continue;
    }

    const { charge, total, overage, prepaid } = settled;

    const chargeable = canCharge && org.subscriptionStatus === 'ACTIVE' && org.cashfreeSubscriptionId;

    let status = 'manual';
    if (chargeable) {
      const paymentId = `ovg_${charge.id}`;
      const scheduleAt = new Date(Date.now() + CHARGE_LEAD_MS);
      try {
        const res = await chargeSubscription({
          cfg,
          subscriptionId: org.cashfreeSubscriptionId!,
          paymentId,
          amountInr: total,
          remarks: `VaaniYantra ${month} usage`,
          scheduleAt,
        });
        await prisma.overageCharge.update({
          where: { id: charge.id },
          data: { status: 'charged', gatewayPaymentId: paymentId },
        });
        status = `charged (${res.status}, debits ${scheduleAt.toISOString().slice(0, 10)})`;
      } catch (err: any) {
        await prisma.overageCharge.update({ where: { id: charge.id }, data: { status: 'failed' } });
        status = `failed: ${err?.message ?? 'unknown'}`;
      }
    } else {
      await prisma.overageCharge.update({ where: { id: charge.id }, data: { status: 'manual' } });
    }
    results.push({
      org: org.name,
      minutes: overage.minutes,
      amountInr: total,
      status,
      ...(prepaid.covered > 0 ? { prepaidMinutes: prepaid.covered } : {}),
      ...(rate.cardId ? { rateCardId: rate.cardId } : {}),
    });
  }

  return results;
}
