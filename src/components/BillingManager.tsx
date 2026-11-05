'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Button, Spinner, Input, Badge, Field, Select } from '@/components/ui';
import { useToast, useConfirm } from '@/components/Feedback';
import { openCashfreeCheckout } from '@/lib/cashfree-client';

type Limits = {
  agents: number;
  workspaces: number;
  callMinutesPerMonth: number;
  knowledgeDocs: number;
  chatbots: number;
  chatConversationsPerMonth: number;
};
type Usage = {
  agents: number;
  workspaces: number;
  callMinutes: number;
  knowledgeDocs: number;
  chatbots: number;
  chatConversations: number;
};
type Overage = { minutes: number; amountInr: number; ratePerMinute: number | null };
// Only what this page still reads off the catalogue: enough to recognise the
// org's own plan and tell a paid one from a free one. The full plan shape went
// with the pricing grid.
type PlanRow = { key: string; name: string; priceMonthly: number; contactSales?: boolean };
type Addons = { whatsappChat: { enabled: boolean; priceInr: number } };
// Prepaid credits. `remainingMinutes` is what is left to speak before the
// tolerance is touched; `allowanceMinutes` is where the line actually stops.
type Prepaid = {
  balanceMinutes: number;
  usedThisMonth: number;
  remainingMinutes: number;
  toleranceMinutes: number;
  allowanceMinutes: number;
  uncoveredThisMonth: number;
  ratePerMinute: number;
  dueInr: number;
  creditsEnforced: boolean;
  minTopUpMinutes: number;
};
type Data = {
  plan: string;
  planName: string;
  // Pay-per-minute: no monthly fee, nothing bought up front, and `overage` is
  // the whole month's bill rather than the part past an allowance.
  usageBased: boolean;
  ratePerMinute: number | null;
  limits: Limits;
  usage: Usage;
  overage: Overage;
  canManage: boolean;
  plans: PlanRow[];
  paymentsConfigured: boolean;
  // 'subscription' = a mandate Cashfree auto-debits. 'order' = one month per
  // payment, so the org has to come back and renew.
  checkoutMode: 'subscription' | 'order';
  subscribed: boolean;
  paidUntil: string | null;
  billingPhone: string;
  prepaid: Prepaid;
  addons: Addons;
};

type Invoice = {
  id: string;
  number: string;
  description: string;
  totalInr: number;
  status: string;
  issuedAt: string;
  paymentMethod: string | null;
};

type Details = {
  billingName: string;
  /** Composed server-side from the structured fields; display only. */
  billingAddress: string;
  billingLine1: string;
  billingLine2: string;
  billingCity: string;
  billingPostalCode: string;
  billingCountry: string;
  billingRegion: string;
  gstin: string;
  gstStateCode: string;
  orgName: string;
  countries: { code: string; name: string; dial: string }[];
  states: { code: string; name: string }[];
};

const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-IN') : '∞');
const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const DAY_MS = 24 * 60 * 60 * 1000;

// Meters for what this plan actually includes. A limit of 0 means the product
// line doesn't cover it at all — showing a permanently-full '0 / 0' bar for a
// feature the clinic never bought would read as a problem rather than a fact.
function meterRows(limits: Limits, usage: Usage, usageBased: boolean) {
  return [
    { label: 'Agents', used: usage.agents, limit: limits.agents },
    { label: 'Workspaces', used: usage.workspaces, limit: limits.workspaces },
    // On a pay-per-minute account the minute "limit" is a runaway-usage safety
    // cap, not something the clinic bought. Drawing it as a progress bar next
    // to the agent and document allowances would read as an allowance being
    // used up — the minutes get their own line above, with what they cost.
    ...(usageBased
      ? []
      : [{ label: 'Call minutes (this month)', used: usage.callMinutes, limit: limits.callMinutesPerMonth }]),
    { label: 'Patient chatbots', used: usage.chatbots, limit: limits.chatbots },
    { label: 'Patient conversations (this month)', used: usage.chatConversations, limit: limits.chatConversationsPerMonth },
    { label: 'Knowledge documents', used: usage.knowledgeDocs, limit: limits.knowledgeDocs },
  ].filter((r) => r.limit !== 0);
}

export function BillingManager() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [details, setDetails] = useState<Details | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [topUpMinutes, setTopUpMinutes] = useState('');
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    const d = await fetch('/api/billing').then((r) => r.json());
    setData(d);
  }
  async function loadInvoices() {
    const r = await fetch('/api/billing/invoices').then((x) => x.json()).catch(() => ({}));
    setInvoices(r.invoices ?? []);
  }
  async function loadDetails() {
    const r = await fetch('/api/billing/details').then((x) => x.json()).catch(() => null);
    if (r) setDetails(r);
  }

  useEffect(() => {
    load();
    loadInvoices();
    loadDetails();
  }, []);

  // Surface the outcome Cashfree redirected back with, then drop the query param
  // so a refresh doesn't repeat the message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get('cashfree');
    if (!state) return;
    if (state === 'minutes')
      toast('Payment received — your minutes have been added to the balance.', 'success');
    else if (state === 'success') toast('Payment received — your plan is active.', 'success');
    else if (state === 'pending')
      toast('Your payment is still being confirmed. This page updates once it clears.', 'info');
    else if (state === 'failed') toast('The payment was not completed. Your plan is unchanged.', 'error');
    else toast('We could not confirm that payment. Please check before trying again.', 'error');
    window.history.replaceState({}, '', window.location.pathname);
  }, [toast]);

  /** Paying happens on its own page, where the full billing identity is collected. */
  function goToCheckout(plan: string) {
    router.push(`/checkout?plan=${encodeURIComponent(plan)}`);
  }

  /**
   * Buy prepaid minutes. The amount shown here is display-only — /api/billing/topup
   * re-quotes against the org's own rate before anything is charged.
   */
  async function buyMinutes() {
    const minutes = Math.floor(Number(topUpMinutes));
    if (!Number.isFinite(minutes) || minutes <= 0) {
      toast('Enter how many minutes you want to buy.', 'error');
      return;
    }
    setBusy(true);
    const res = await fetch('/api/billing/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes }),
    });
    const b = await res.json().catch(() => ({}));
    if (res.ok && b.sessionId) {
      try {
        await openCashfreeCheckout('order', b.sessionId, b.environment); // leaves the page
        return;
      } catch (err: any) {
        toast(err?.message || 'Could not open the payment page.', 'error');
      }
    } else {
      toast(b.error || 'Could not start the payment.', 'error');
    }
    setBusy(false);
  }

  async function saveDetails() {
    if (!details) return;
    setBusy(true);
    const res = await fetch('/api/billing/details', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        billingName: details.billingName,
        billingLine1: details.billingLine1,
        billingLine2: details.billingLine2,
        billingCity: details.billingCity,
        billingPostalCode: details.billingPostalCode,
        billingCountry: details.billingCountry,
        billingRegion: details.billingRegion,
        gstin: details.gstin,
        gstStateCode: details.gstStateCode,
      }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setDetailErrors(b.errors ?? {});
      toast(b.error || 'Could not save billing details.', 'error');
      return;
    }
    setDetailErrors({});
    toast('Billing details saved.', 'success');
    setEditingDetails(false);
    await loadDetails();
  }

  async function toggleWhatsappChat(enabled: boolean) {
    if (
      enabled &&
      !(await confirm({
        title: 'Enable WhatsApp follow-up chat?',
        message: `Callers can text follow-up questions on WhatsApp, answered from your agent’s knowledge base. This adds ₹${data?.addons.whatsappChat.priceInr.toLocaleString('en-IN')}/month to your bill.`,
        confirmLabel: 'Enable add-on',
      }))
    )
      return;
    setBusy(true);
    const res = await fetch('/api/billing/addon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addon: 'whatsappChat', enabled }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) toast(b.error || 'Could not update the add-on.', 'error');
    setBusy(false);
    await load();
  }

  async function cancelSubscription() {
    if (
      !(await confirm({
        title: 'Cancel your subscription?',
        message: 'The payment mandate is revoked and your organization drops to the Free plan immediately.',
        confirmLabel: 'Cancel subscription',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    const res = await fetch('/api/billing/cancel', { method: 'POST' });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) toast(b.error || 'Could not cancel the subscription.', 'error');
    setBusy(false);
    await load();
  }

  if (!data) return <Spinner />;

  const paidUntilMs = data.paidUntil ? new Date(data.paidUntil).getTime() : null;
  const daysLeft = paidUntilMs === null ? null : Math.ceil((paidUntilMs - Date.now()) / DAY_MS);
  // "Paid" is a property of the plan, not of its key — checking `!== 'free'`
  // broke the moment the catalogue grew past one free tier.
  const current = data.plans.find((p) => p.key === data.plan);
  const isPaid = (current?.priceMonthly ?? 0) > 0 || Boolean(current?.contactSales);
  // A usage account has nothing to renew: there is no paid period, only last
  // month's minutes. The renewal banner below is for the legacy monthly plans.
  // Display only: the route re-quotes at the org's own rate before charging.
  const topUpWanted = Math.floor(Number(topUpMinutes));
  const topUpPrice =
    Number.isFinite(topUpWanted) && topUpWanted > 0 && data.prepaid.ratePerMinute > 0
      ? Math.round(topUpWanted * data.prepaid.ratePerMinute * 100) / 100
      : null;

  const needsRenewal =
    !data.usageBased && data.checkoutMode === 'order' && isPaid && daysLeft !== null && daysLeft <= 7;

  return (
    <div className="space-y-6">
      {/* ── Plan summary ─────────────────────────────────────────────── */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="h-display text-xl font-semibold">
                {data.usageBased && data.ratePerMinute != null
                  ? `₹${data.ratePerMinute} / minute`
                  : data.planName}
              </h2>
              {data.usageBased ? (
                <Badge tone="success">pay for what you use</Badge>
              ) : isPaid ? (
                <Badge tone={needsRenewal ? 'warning' : 'success'}>
                  {data.subscribed ? 'auto-renewing' : 'active'}
                </Badge>
              ) : (
                <Badge tone="neutral">free plan</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {data.usageBased ? (
                <>
                  Billed at the end of each month for the minutes your agents actually spend on calls. No monthly
                  fee and no minimum — this month so far, {fmt(data.usage.callMinutes)} minute
                  {data.usage.callMinutes === 1 ? '' : 's'} = {inr(data.overage.amountInr)}.
                </>
              ) : data.paidUntil && isPaid ? (
                <>
                  {data.subscribed ? 'Renews' : 'Paid through'}{' '}
                  <span className="text-ink">{fmtDate(data.paidUntil)}</span>
                  {daysLeft !== null && daysLeft >= 0 && !data.subscribed && (
                    <> · {daysLeft} day{daysLeft === 1 ? '' : 's'} left</>
                  )}
                </>
              ) : isPaid ? (
                'Your plan is active.'
              ) : (
                'Talk to us to move onto the per-minute rate.'
              )}
              {!data.usageBased &&
                !data.paymentsConfigured &&
                ' Online payments aren’t set up yet — an owner can switch plans manually below.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.canManage && needsRenewal && (
              <Button size="sm" onClick={() => goToCheckout(data.plan)} disabled={busy}>
                Renew now
              </Button>
            )}
            {data.canManage && data.subscribed && (
              <Button size="sm" variant="secondary" onClick={cancelSubscription} disabled={busy}>
                Cancel subscription
              </Button>
            )}
          </div>
        </div>

        {needsRenewal && (
          <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink-soft">
            {daysLeft! > 0
              ? `Your plan ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
              : 'Your plan has ended.'}{' '}
            Payments are one month at a time, so nothing is charged automatically — renew to keep your agents
            running.
          </p>
        )}
      </Card>

      {/* ── Usage ────────────────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <h3 className="text-sm font-medium uppercase tracking-wider text-muted">Usage this period</h3>
        <div className="space-y-3">
          {meterRows(data.limits, data.usage, data.usageBased).map((r) => {
            const pct =
              Number.isFinite(r.limit) && r.limit > 0 ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0;
            const over = Number.isFinite(r.limit) && r.used >= r.limit;
            return (
              <div key={r.label}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-muted">{r.label}</span>
                  <span className={over ? 'text-danger' : 'text-ink-soft'}>
                    {fmt(r.used)} / {fmt(r.limit)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={`h-full ${over ? 'bg-danger' : 'bg-primary'}`}
                    style={{ width: `${Number.isFinite(r.limit) ? pct : 6}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {data.usageBased ? (
          <p className="text-xs text-ink-soft">
            {fmt(data.usage.callMinutes)} call minute{data.usage.callMinutes === 1 ? '' : 's'} this month at ₹
            {data.ratePerMinute}/min — {inr(data.overage.amountInr)} so far. Invoiced after the month ends.
          </p>
        ) : (
          data.overage.minutes > 0 && (
            <p className="text-xs text-ink-soft">
              You’re {fmt(data.overage.minutes)} minutes over your included allowance this month — extra usage
              bills at ₹{data.overage.ratePerMinute}/min ({inr(data.overage.amountInr)} so far), added to your
              next invoice.
            </p>
          )
        )}
      </Card>

      {/* ── Prepaid minutes ───────────────────────────── */}
      {/* Shown to a legacy monthly org too, whenever it still holds a balance:
          those are minutes it paid for, and hiding them would look like we had
          taken them. Only a per-minute account can buy more. */}
      {(data.usageBased || data.prepaid.balanceMinutes > 0) && (
        <Card className="space-y-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-medium uppercase tracking-wider text-muted">Prepaid minutes</h3>
              <p className="h-display mt-1 text-2xl font-semibold text-ink">
                {fmt(data.prepaid.remainingMinutes)} minute{data.prepaid.remainingMinutes === 1 ? '' : 's'} left
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {data.prepaid.balanceMinutes > 0
                  ? `${fmt(data.prepaid.usedThisMonth)} of ${fmt(data.prepaid.balanceMinutes)} used this month. `
                  : 'No minutes bought yet. '}
                {data.prepaid.creditsEnforced ? (
                  <>
                    Your agents keep answering for {fmt(data.prepaid.toleranceMinutes)} minute
                    {data.prepaid.toleranceMinutes === 1 ? '' : 's'} past the balance — those are invoiced with
                    next month’s usage — and then the line stops until you top up.
                  </>
                ) : (
                  <>Anything past the balance is invoiced after the month ends, not blocked.</>
                )}
              </p>
            </div>
            {data.prepaid.creditsEnforced && data.prepaid.remainingMinutes === 0 && (
              <Badge tone="warning">out of minutes</Badge>
            )}
          </div>

          {data.prepaid.uncoveredThisMonth > 0 && (
            <p className="text-xs text-ink-soft">
              {fmt(data.prepaid.uncoveredThisMonth)} minute
              {data.prepaid.uncoveredThisMonth === 1 ? '' : 's'} this month are past the balance —{' '}
              {inr(data.prepaid.dueInr)} to be invoiced after the month ends.
            </p>
          )}

          {data.canManage && data.usageBased && (
            <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <div className="w-36">
                <Field label="Minutes">
                  <Input
                    type="number"
                    min={data.prepaid.minTopUpMinutes}
                    step={100}
                    placeholder={String(data.prepaid.minTopUpMinutes)}
                    value={topUpMinutes}
                    onChange={(e) => setTopUpMinutes(e.target.value)}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2 pb-1">
                {[1000, 2000, 5000, 10000].map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant="secondary"
                    onClick={() => setTopUpMinutes(String(m))}
                    disabled={busy}
                  >
                    {fmt(m)}
                  </Button>
                ))}
              </div>
              <Button onClick={buyMinutes} disabled={busy || !data.paymentsConfigured}>
                {topUpPrice != null ? `Buy for ${inr(topUpPrice)}` : 'Buy minutes'}
              </Button>
            </div>
          )}

          {data.canManage && data.usageBased && (
            <p className="text-xs text-ink-soft">
              ₹{data.prepaid.ratePerMinute}/minute, minimum {fmt(data.prepaid.minTopUpMinutes)} minutes. GST is
              added at checkout. Minutes never expire — whatever is left carries into next month.
              {!data.paymentsConfigured && ' Online payments aren’t set up yet.'}
            </p>
          )}
        </Card>
      )}

      {/* ── Add-ons ──────────────────────────────────────────────────── */}
      {(data.addons.whatsappChat.priceInr > 0 || data.addons.whatsappChat.enabled) && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-6">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink">WhatsApp follow-up chat</h3>
            <p className="mt-0.5 text-sm text-muted">
              Callers can text follow-up questions on WhatsApp after a call — answered automatically from your
              agent’s knowledge base.
              {data.addons.whatsappChat.priceInr > 0 && (
                <> ₹{data.addons.whatsappChat.priceInr.toLocaleString('en-IN')}/month.</>
              )}
            </p>
          </div>
          {data.canManage &&
            (data.addons.whatsappChat.enabled ? (
              <Button size="sm" variant="secondary" onClick={() => toggleWhatsappChat(false)} disabled={busy}>
                Turn off
              </Button>
            ) : (
              <Button size="sm" onClick={() => toggleWhatsappChat(true)} disabled={busy}>
                Enable
              </Button>
            ))}
        </Card>
      )}

      {/* ── What it costs ─────────────────────────────────────────────
          There is no plan grid here any more. Every tier was retired in favour
          of one per-minute rate, so the only honest thing this section can do
          is state that rate and say who to talk to about changing it — a grid
          of options nobody can choose is worse than no grid at all. Clinics
          still on a retired monthly plan keep it, and see it named above. */}
      <Card className="space-y-2 p-6">
        <h3 className="text-sm font-medium uppercase tracking-wider text-muted">Your rate</h3>
        {data.usageBased && data.ratePerMinute != null ? (
          <>
            <p className="h-display text-2xl font-semibold text-ink">₹{data.ratePerMinute} / minute</p>
            <p className="text-sm leading-relaxed text-muted">
              Everything is included at that rate — voice agents, the patient chatbot, every branch and every
              consultant. Running at higher volume across several branches? Write to{' '}
              <a className="text-ink underline underline-offset-2" href="mailto:info@vaaniyantra.com">
                info@vaaniyantra.com
              </a>{' '}
              and we will agree a volume rate with you.
            </p>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            You are on <span className="text-ink">{data.planName}</span>, a plan we no longer sell — you keep it,
            and its price, for as long as you like. Everything new is billed at a single per-minute rate instead.
            Write to{' '}
            <a className="text-ink underline underline-offset-2" href="mailto:info@vaaniyantra.com">
              info@vaaniyantra.com
            </a>{' '}
            if you would rather move across.
          </p>
        )}
      </Card>

      {/* ── Billing details ──────────────────────────────────────────── */}
      {details && (
        <Card className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-ink">Billing details</h3>
              <p className="mt-0.5 text-sm text-muted">
                Shown on your invoices. Add a GSTIN to claim input credit — it also sets your place of supply,
                which decides whether GST appears as CGST+SGST or IGST.
              </p>
            </div>
            {data.canManage && !editingDetails && (
              <Button size="sm" variant="secondary" onClick={() => setEditingDetails(true)} disabled={busy}>
                Edit
              </Button>
            )}
          </div>

          {editingDetails ? (
            <div className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Registered name">
                  <Input
                    value={details.billingName}
                    onChange={(e) => setDetails({ ...details, billingName: e.target.value })}
                    aria-invalid={Boolean(detailErrors.billingName)}
                  />
                </Field>
                <Field label="Country">
                  <Select
                    value={details.billingCountry}
                    onChange={(e) =>
                      // Dropping the tax identity of the country being left keeps
                      // a GSTIN from surviving a move out of India.
                      setDetails(
                        e.target.value === 'IN'
                          ? { ...details, billingCountry: e.target.value, billingRegion: '' }
                          : { ...details, billingCountry: e.target.value, gstin: '', gstStateCode: '' },
                      )
                    }
                  >
                    {details.countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Address">
                <Input
                  value={details.billingLine1}
                  onChange={(e) => setDetails({ ...details, billingLine1: e.target.value })}
                  placeholder="Building, street"
                />
              </Field>
              <Field label="Address line 2 (optional)">
                <Input
                  value={details.billingLine2}
                  onChange={(e) => setDetails({ ...details, billingLine2: e.target.value })}
                  placeholder="Area, landmark"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="City">
                  <Input
                    value={details.billingCity}
                    onChange={(e) => setDetails({ ...details, billingCity: e.target.value })}
                  />
                </Field>
                <Field label={details.billingCountry === 'IN' ? 'PIN code' : 'Postal / ZIP code'}>
                  <Input
                    value={details.billingPostalCode}
                    onChange={(e) =>
                      setDetails({
                        ...details,
                        billingPostalCode:
                          details.billingCountry === 'IN'
                            ? e.target.value.replace(/\D/g, '').slice(0, 6)
                            : e.target.value.slice(0, 12),
                      })
                    }
                    placeholder={details.billingCountry === 'IN' ? '531114' : ''}
                    inputMode={details.billingCountry === 'IN' ? 'numeric' : 'text'}
                    aria-invalid={Boolean(detailErrors.billingPostalCode)}
                  />
                  {detailErrors.billingPostalCode && (
                    <p className="mt-1.5 text-xs text-danger">{detailErrors.billingPostalCode}</p>
                  )}
                </Field>
              </div>
              {details.billingCountry === 'IN' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="State (place of supply)"
                    hint={details.gstin.trim() ? 'Taken from your GSTIN’s first two digits.' : undefined}
                  >
                    <Select
                      value={details.gstStateCode}
                      onChange={(e) => setDetails({ ...details, gstStateCode: e.target.value })}
                      disabled={Boolean(details.gstin.trim())}
                    >
                      <option value="">Select…</option>
                      {details.states.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="GSTIN (optional)">
                    <Input
                      className="font-mono uppercase"
                      value={details.gstin}
                      onChange={(e) => setDetails({ ...details, gstin: e.target.value.toUpperCase() })}
                      placeholder="37ABCDE1234F1Z5"
                      aria-invalid={Boolean(detailErrors.gstin)}
                    />
                    {detailErrors.gstin && (
                      <p className="mt-1.5 text-xs text-danger">{detailErrors.gstin}</p>
                    )}
                  </Field>
                </div>
              ) : (
                <Field label="State / province (optional)">
                  <Input
                    className="max-w-xs"
                    value={details.billingRegion}
                    onChange={(e) => setDetails({ ...details, billingRegion: e.target.value })}
                  />
                </Field>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={saveDetails} disabled={busy}>
                  Save details
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditingDetails(false);
                    setDetailErrors({});
                    loadDetails();
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">Name</dt>
                <dd className="text-ink">{details.billingName || details.orgName}</dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">Country</dt>
                <dd className="text-ink">
                  {details.countries.find((c) => c.code === details.billingCountry)?.name ?? '—'}
                </dd>
              </div>
              {details.billingCountry === 'IN' && (
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-muted">GSTIN</dt>
                  <dd className="font-mono text-ink">{details.gstin || '—'}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">{details.billingCountry === 'IN' ? 'State' : 'State / province'}</dt>
                <dd className="text-ink">
                  {details.billingCountry === 'IN'
                    ? (details.states.find((s) => s.code === details.gstStateCode)?.name ?? '—')
                    : details.billingRegion || '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-muted">Address</dt>
                <dd className="whitespace-pre-line text-ink">{details.billingAddress || '—'}</dd>
              </div>
            </dl>
          )}
        </Card>
      )}

      {/* ── Invoices ─────────────────────────────────────────────────── */}
      <Card className="p-6">
        <h3 className="text-sm font-medium text-ink">Invoices</h3>
        {invoices.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No invoices yet — one is issued automatically each time a payment settles.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="pb-2 pr-4">Invoice</th>
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Description</th>
                  <th className="pb-2 pr-4 text-right">Amount</th>
                  <th className="pb-2 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink">{i.number}</td>
                    <td className="py-2.5 pr-4 text-muted">{fmtDate(i.issuedAt)}</td>
                    <td className="py-2.5 pr-4 text-muted">{i.description}</td>
                    <td className="py-2.5 pr-4 text-right text-ink">{inr(i.totalInr)}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <a
                        className="text-xs text-primary hover:underline"
                        href={`/invoices/${i.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!data.canManage && (
        <p className="text-xs text-muted">Only the organization owner can change the plan.</p>
      )}
    </div>
  );
}
