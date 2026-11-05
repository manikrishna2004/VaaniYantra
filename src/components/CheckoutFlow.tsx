'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Globe, Lock, Mail, ShieldCheck } from 'lucide-react';
import { Card, Button, Spinner, Input, Select, Field, PageSkeleton } from '@/components/ui';
import { useToast } from '@/components/Feedback';
import { openCashfreeCheckout } from '@/lib/cashfree-client';

// A full checkout page: contact details, a billing address, the promo code, and
// a priced order summary — everything collected before anyone is handed off to
// Cashfree's hosted payment page.
//
// India is the only country with GST rules to honour (GSTIN, place of supply,
// 6-digit PIN); everywhere else the region is free text and the sale is an
// export of service, which carries no GST.
//
// The summary is display-only. /api/billing/checkout recomputes the price, the
// discount and the tax server-side from the same functions, so nothing shown
// here can change what is actually charged.

type Billing = {
  plan: string;
  planName: string;
  // Only what this page reads off the catalogue: enough to recognise the plan
  // being bought. The full shape went with the pricing grid — and with monthly
  // plans retired in favour of a per-minute rate, nothing reaches this page
  // self-serve any more (see checkoutPlanError). It is kept working so an
  // un-retired plan is sellable again without rebuilding checkout.
  plans: {
    key: string;
    name: string;
    priceMonthly: number;
    overagePerMinute?: number;
    limits: {
      agents: number;
      callMinutesPerMonth: number;
      knowledgeDocs: number;
      chatbots: number;
      chatConversationsPerMonth: number;
    };
  }[];
  canManage: boolean;
  paymentsConfigured: boolean;
  checkoutMode: 'subscription' | 'order';
  subscribed: boolean;
  billingPhone: string;
  /** False = a card issued outside India cannot be charged yet. */
  internationalPayments: boolean;
};

type Details = {
  billingName: string;
  billingLine1: string;
  billingLine2: string;
  billingCity: string;
  billingPostalCode: string;
  billingCountry: string;
  billingRegion: string;
  billingPhone: string;
  billingEmail: string;
  gstin: string;
  gstStateCode: string;
  orgName: string;
  countries: { code: string; name: string; dial: string }[];
  states: { code: string; name: string }[];
};

type Quote = {
  planName: string;
  subtotalInr: number;
  discountInr: number;
  taxableInr: number;
  cgstInr: number;
  sgstInr: number;
  igstInr: number;
  totalInr: number;
  taxRate: number;
  taxKind: 'intra' | 'inter' | 'export' | 'none';
  promo: { code: string; label: string } | null;
  promoError: string | null;
};

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-IN') : 'Unlimited');

function Section({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-soft">
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="h-display text-lg font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          <div className="mt-4 space-y-4">{children}</div>
        </div>
      </div>
    </Card>
  );
}

function ErrorText({ children }: { children?: string }) {
  if (!children) return null;
  return <p className="mt-1.5 text-xs text-danger">{children}</p>;
}

export function CheckoutFlow({ plan, email }: { plan: string; email: string }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [phone, setPhone] = useState('');
  const [promo, setPromo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    (async () => {
      const [b, d] = await Promise.all([
        fetch('/api/billing').then((r) => r.json()).catch(() => null),
        fetch('/api/billing/details').then((r) => r.json()).catch(() => null),
      ]);
      if (!b || !d) {
        setLoadError('Could not load your billing details. Please refresh and try again.');
        return;
      }
      setBilling(b);
      setDetails(d);
      setPhone(d.billingPhone || b.billingPhone || '');
    })();
  }, []);

  const refreshQuote = useCallback(
    async (code: string) => {
      const res = await fetch('/api/billing/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, promoCode: code || undefined }),
      });
      const b = await res.json().catch(() => null);
      if (res.ok && b) setQuote(b);
      else setLoadError(b?.error || 'Could not price this plan.');
      return b as Quote | null;
    },
    [plan],
  );

  useEffect(() => {
    refreshQuote('');
  }, [refreshQuote]);

  function setField(key: keyof Details, value: string) {
    setDetails((d) => (d ? { ...d, [key]: value } : d));
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e));
  }

  /**
   * Switching country changes which tax identity applies, so drop the fields
   * that belong to the country being left rather than carrying dead data.
   */
  function setCountry(code: string) {
    setDetails((d) =>
      d
        ? code === 'IN'
          ? { ...d, billingCountry: code, billingRegion: '' }
          : { ...d, billingCountry: code, gstin: '', gstStateCode: '' }
        : d,
    );
    setErrors({});
  }

  /** A GSTIN starts with its state code, so keep place of supply in step with it. */
  function setGstin(value: string) {
    const gstin = value.toUpperCase();
    setDetails((d) => {
      if (!d) return d;
      const code = /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null;
      const known = code && d.states.some((s) => s.code === code);
      return { ...d, gstin, gstStateCode: known ? code! : d.gstStateCode };
    });
    setErrors((e) => ({ ...e, gstin: '', gstStateCode: '' }));
  }

  async function applyPromoCode() {
    if (!promo.trim()) return;
    setBusy(true);
    const q = await refreshQuote(promo.trim());
    setBusy(false);
    if (q?.promoError) toast(q.promoError, 'error');
    else if (q?.promo) toast(`Code applied — you'll pay ${inr(q.totalInr)}.`, 'success');
  }

  /** Mirrors the server's strict validation so mistakes surface before payment. */
  function validate(d: Details, phoneDigits: string): Record<string, string> {
    const next: Record<string, string> = {};
    const indian = d.billingCountry === 'IN';

    if (indian ? !/^[6-9]\d{9}$/.test(phoneDigits) : !/^\d{7,15}$/.test(phoneDigits))
      next.phone = indian
        ? 'Enter a valid 10-digit Indian mobile number.'
        : 'Enter a valid phone number, including your country code.';
    if (!d.billingName.trim()) next.billingName = 'Enter the name this should be billed to.';
    if (!d.billingLine1.trim()) next.billingLine1 = 'Enter your street address.';
    if (!d.billingCity.trim()) next.billingCity = 'Enter your city.';
    if (indian) {
      if (!d.gstStateCode) next.gstStateCode = 'Select your state.';
      if (!/^\d{6}$/.test(d.billingPostalCode.trim())) next.billingPostalCode = 'Enter a 6-digit PIN code.';
      if (d.gstin.trim() && !/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]$/.test(d.gstin.trim()))
        next.gstin = 'That GSTIN doesn’t look right — 15 characters, e.g. 37ABCDE1234F1Z5.';
    } else if (d.billingPostalCode.trim().length > 12) {
      next.billingPostalCode = 'That postal code is too long.';
    }
    return next;
  }

  async function pay() {
    if (!details || !billing) return;
    const indian = details.billingCountry === 'IN';
    const digits = phone.replace(/\D/g, '');
    const phoneDigits = indian ? digits.replace(/^(?:91|0)(?=\d{10}$)/, '') : digits;
    const found = validate(details, phoneDigits);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast('Please fix the highlighted fields.', 'error');
      document.querySelector('[aria-invalid="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setBusy(true);
    // Save the billing identity first: the invoice issued when the payment
    // settles reads it straight off the org, and checkout refuses without it.
    const saved = await fetch('/api/billing/details', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strict: true,
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
    const savedBody = await saved.json().catch(() => ({}));
    if (!saved.ok) {
      setErrors(savedBody.errors ?? {});
      toast(savedBody.error || 'Could not save your billing details.', 'error');
      setBusy(false);
      return;
    }

    // Country and place of supply may have changed the tax — re-price before
    // charging so the amount on screen is the amount Cashfree asks for.
    const fresh = await refreshQuote(quote?.promo?.code ?? '');

    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan,
        phone: phoneDigits,
        ...(fresh?.promo ? { promoCode: fresh.promo.code } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.sessionId) {
      try {
        await openCashfreeCheckout(body.mode, body.sessionId, body.environment); // leaves the page
        return;
      } catch (err: any) {
        toast(err?.message || 'Could not open the payment page.', 'error');
      }
    } else {
      setErrors(body.errors ?? {});
      toast(body.error || 'Could not start checkout.', 'error');
    }
    setBusy(false);
  }

  if (loadError) {
    return (
      <Card className="p-6">
        <p className="text-sm text-danger">{loadError}</p>
        <Link href="/settings/billing" className="mt-3 inline-block text-sm text-primary hover:underline">
          Back to billing
        </Link>
      </Card>
    );
  }
  if (!billing || !details) return <PageSkeleton rows={3} />;

  const catalogue = billing.plans.find((p) => p.key === plan);
  if (!catalogue || !billing.paymentsConfigured || !billing.canManage) {
    return (
      <Card className="p-6">
        <p className="text-sm text-ink-soft">
          {!billing.canManage
            ? 'Only the organization owner can change the plan.'
            : !billing.paymentsConfigured
              ? 'Online payments aren’t set up yet, so this plan can’t be bought here.'
              : 'That plan is not available.'}
        </p>
        <Link href="/settings/billing" className="mt-3 inline-block text-sm text-primary hover:underline">
          Back to billing
        </Link>
      </Card>
    );
  }

  const subscription = billing.checkoutMode === 'subscription';
  const renewal = billing.plan === plan;
  const indian = details.billingCountry === 'IN';
  const dial = details.countries.find((c) => c.code === details.billingCountry)?.dial;
  // Our payment provider can't charge a foreign card yet, so there is nothing to
  // gain by sending this customer to a checkout that will decline them.
  const unavailableHere = !indian && !billing.internationalPayments;
  const countryLabel =
    details.countries.find((c) => c.code === details.billingCountry)?.name ?? details.billingCountry;
  const salesMailto =
    `mailto:info@vaaniyantra.com?subject=${encodeURIComponent(`${catalogue.name} plan — ${countryLabel}`)}` +
    `&body=${encodeURIComponent(
      `Hello,\n\nI'd like the ${catalogue.name} plan for my business in ${countryLabel}.\n\nOrganization: ${details.orgName}\nEmail: ${details.billingEmail || email}\n`,
    )}`;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings/billing"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back to billing
        </Link>
        <h1 className="mt-3 h-display text-2xl font-semibold">
          {renewal ? `Renew ${catalogue.name}` : `Upgrade to ${catalogue.name}`}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {subscription
            ? 'Confirm your details, then authorize the monthly mandate on Cashfree’s secure page.'
            : 'Confirm your details, then pay for the month on Cashfree’s secure page.'}
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        {/* ── Details ────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Section
            step={1}
            title="Contact"
            description="Where the payment receipt and invoices are sent."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email">
                <Input value={details.billingEmail || email} readOnly disabled />
              </Field>
              <Field
                label="Phone number"
                hint={
                  indian
                    ? 'Required by the payment gateway.'
                    : `Include your country code${dial ? ` (+${dial})` : ''}.`
                }
              >
                <Input
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setErrors((x) => ({ ...x, phone: '' }));
                  }}
                  placeholder={indian ? '98765 43210' : dial ? `+${dial} …` : '+1 555 000 0000'}
                  inputMode="tel"
                  autoComplete="tel"
                  aria-invalid={Boolean(errors.phone)}
                />
                <ErrorText>{errors.phone}</ErrorText>
              </Field>
            </div>
          </Section>

          <Section
            step={2}
            title="Billing address"
            description={
              indian
                ? 'Printed on your tax invoice. Your state sets the place of supply, which decides whether GST appears as CGST+SGST or IGST.'
                : 'Printed on your invoice.'
            }
          >
            <Field label="Billed to (registered name)">
              <Input
                value={details.billingName}
                onChange={(e) => setField('billingName', e.target.value)}
                autoComplete="organization"
                aria-invalid={Boolean(errors.billingName)}
              />
              <ErrorText>{errors.billingName}</ErrorText>
            </Field>

            <Field label="Country">
              <Select
                value={details.billingCountry}
                onChange={(e) => setCountry(e.target.value)}
                autoComplete="country"
              >
                {details.countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
              {unavailableHere && (
                <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-snug text-ink-soft">
                  We can’t take card payments in {countryLabel} yet — our payment provider is still completing that
                  approval. Fill this in anyway and we’ll set your plan up directly.
                </p>
              )}
            </Field>

            <Field label="Address">
              <Input
                value={details.billingLine1}
                onChange={(e) => setField('billingLine1', e.target.value)}
                placeholder="Building, street"
                autoComplete="address-line1"
                aria-invalid={Boolean(errors.billingLine1)}
              />
              <ErrorText>{errors.billingLine1}</ErrorText>
            </Field>

            <Field label="Address line 2 (optional)">
              <Input
                value={details.billingLine2}
                onChange={(e) => setField('billingLine2', e.target.value)}
                placeholder="Area, landmark"
                autoComplete="address-line2"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="City">
                <Input
                  value={details.billingCity}
                  onChange={(e) => setField('billingCity', e.target.value)}
                  autoComplete="address-level2"
                  aria-invalid={Boolean(errors.billingCity)}
                />
                <ErrorText>{errors.billingCity}</ErrorText>
              </Field>
              <Field label={indian ? 'PIN code' : 'Postal / ZIP code (optional)'}>
                <Input
                  value={details.billingPostalCode}
                  onChange={(e) =>
                    setField(
                      'billingPostalCode',
                      indian ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value.slice(0, 12),
                    )
                  }
                  placeholder={indian ? '531114' : ''}
                  inputMode={indian ? 'numeric' : 'text'}
                  autoComplete="postal-code"
                  aria-invalid={Boolean(errors.billingPostalCode)}
                />
                <ErrorText>{errors.billingPostalCode}</ErrorText>
              </Field>
            </div>

            {indian ? (
              <>
                <Field
                  label="State"
                  hint={details.gstin.trim() ? 'Taken from your GSTIN’s first two digits.' : undefined}
                >
                  <Select
                    className="max-w-xs"
                    value={details.gstStateCode}
                    onChange={(e) => setField('gstStateCode', e.target.value)}
                    disabled={Boolean(details.gstin.trim())}
                    aria-invalid={Boolean(errors.gstStateCode)}
                  >
                    <option value="">Select…</option>
                    {details.states.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                  <ErrorText>{errors.gstStateCode}</ErrorText>
                </Field>

                <Field label="GSTIN (optional)" hint="Add it to claim input tax credit on this invoice.">
                  <Input
                    className="font-mono uppercase"
                    value={details.gstin}
                    onChange={(e) => setGstin(e.target.value)}
                    placeholder="37ABCDE1234F1Z5"
                    aria-invalid={Boolean(errors.gstin)}
                  />
                  <ErrorText>{errors.gstin}</ErrorText>
                </Field>
              </>
            ) : (
              <Field label="State / province (optional)">
                <Input
                  value={details.billingRegion}
                  onChange={(e) => setField('billingRegion', e.target.value)}
                  autoComplete="address-level1"
                />
              </Field>
            )}
          </Section>
        </div>

        {/* ── Order summary ──────────────────────────────────────────── */}
        <div className="lg:sticky lg:top-8">
          <Card className="p-6">
            <h2 className="h-display text-lg font-semibold">Order summary</h2>

            <div className="mt-4 rounded-xl border border-border bg-surface-2 p-4">
              <p className="text-sm font-medium text-ink">{catalogue.name} plan</p>
              {/* Only list what this product line actually includes — a
                  chatbot-only plan showing "0 call minutes / month" reads as a
                  mistake in the order they are about to pay for. */}
              <ul className="mt-2 space-y-1.5 text-xs text-muted">
                {catalogue.limits.callMinutesPerMonth !== 0 && (
                  <>
                    <li>{fmt(catalogue.limits.agents)} agents</li>
                    <li>{fmt(catalogue.limits.callMinutesPerMonth)} call minutes / month</li>
                  </>
                )}
                {catalogue.limits.chatbots !== 0 && (
                  <>
                    <li>{fmt(catalogue.limits.chatbots)} patient chatbots</li>
                    <li>{fmt(catalogue.limits.chatConversationsPerMonth)} patient conversations / month</li>
                  </>
                )}
                <li>{fmt(catalogue.limits.knowledgeDocs)} knowledge documents</li>
                {catalogue.overagePerMinute != null && (
                  <li>Extra usage ₹{catalogue.overagePerMinute}/min</li>
                )}
              </ul>
            </div>

            {/* Promo codes discount a single order, so they don't apply to a
                mandate that would keep the discounted amount for life. */}
            {!subscription && (
              <div className="mt-4">
                <label className="label" htmlFor="promo-code">
                  Promo code
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="promo-code"
                    className="font-mono uppercase"
                    value={promo}
                    onChange={(e) => setPromo(e.target.value.toUpperCase())}
                    placeholder="CODE"
                  />
                  <Button variant="secondary" onClick={applyPromoCode} disabled={busy || !promo.trim()}>
                    Apply
                  </Button>
                </div>
                {quote?.promo && (
                  <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-success">
                    <Check className="h-3.5 w-3.5" /> {quote.promo.label}
                  </p>
                )}
              </div>
            )}

            {!quote ? (
              <div className="mt-4">
                <Spinner />
              </div>
            ) : (
              <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">{quote.planName} · 1 month</dt>
                  <dd className="text-ink">{inr(quote.subtotalInr)}</dd>
                </div>
                {quote.discountInr > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Discount{quote.promo ? ` (${quote.promo.code})` : ''}</dt>
                    <dd className="text-success">−{inr(quote.discountInr)}</dd>
                  </div>
                )}
                {(quote.taxKind === 'intra' || quote.taxKind === 'inter') && (
                  <>
                    <div className="flex justify-between gap-4 border-t border-border pt-2">
                      <dt className="text-muted">Taxable value</dt>
                      <dd className="text-ink">{inr(quote.taxableInr)}</dd>
                    </div>
                    {quote.igstInr > 0 ? (
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted">IGST @ {quote.taxRate}%</dt>
                        <dd className="text-ink">{inr(quote.igstInr)}</dd>
                      </div>
                    ) : (
                      <>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted">CGST @ {quote.taxRate / 2}%</dt>
                          <dd className="text-ink">{inr(quote.cgstInr)}</dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted">SGST @ {quote.taxRate / 2}%</dt>
                          <dd className="text-ink">{inr(quote.sgstInr)}</dd>
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="flex justify-between gap-4 border-t border-border pt-2 text-base font-semibold">
                  <dt className="text-ink">{subscription ? 'Billed monthly' : 'Total due today'}</dt>
                  <dd className="text-ink">{inr(quote.totalInr)}</dd>
                </div>
                {quote.taxKind === 'export' && (
                  <p className="pt-1 text-[11px] leading-snug text-muted">
                    No GST charged — export of service (zero-rated).
                  </p>
                )}
                {quote.taxKind === 'none' && (
                  <p className="pt-1 text-[11px] leading-snug text-muted">
                    No GST charged — VaaniYantra is not currently GST-registered.
                  </p>
                )}
                {!indian && (
                  <p className="text-[11px] leading-snug text-muted">
                    Charged in Indian rupees (₹). Your bank may apply its own conversion rate.
                  </p>
                )}
              </dl>
            )}

            {unavailableHere ? (
              <div className="mt-5 rounded-xl border border-border bg-surface-2 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Globe className="h-4 w-4 shrink-0 text-primary" />
                  Coming soon in {countryLabel}
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Online card payments outside India are pending approval from our payment provider. Email us and
                  we’ll activate {catalogue.name} for you directly — usually the same working day.
                </p>
                <a
                  href={salesMailto}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
                >
                  <Mail className="h-4 w-4" />
                  Email info@vaaniyantra.com
                </a>
                <p className="mt-2 text-center text-[11px] text-muted">
                  Or switch the country above to India to pay online now.
                </p>
              </div>
            ) : (
              <>
                <Button className="mt-5 w-full" onClick={pay} disabled={busy || !quote}>
                  <Lock className="h-4 w-4" />
                  {quote
                    ? subscription
                      ? `Authorize ${inr(quote.totalInr)}/month`
                      : `Pay ${inr(quote.totalInr)}`
                    : 'Continue'}
                </Button>

                <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-muted">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {subscription
                    ? 'You’ll authorize a UPI Autopay / e-NACH / card mandate on Cashfree’s page. It renews automatically each month until you cancel.'
                    : 'This pays for one month. Nothing is charged automatically — we’ll remind you on the billing page before it runs out.'}
                </p>
                <p className="mt-2 text-[11px] leading-snug text-muted">
                  By paying you agree to our{' '}
                  <a href="/terms" className="text-primary hover:underline" target="_blank" rel="noreferrer">
                    Terms
                  </a>{' '}
                  and{' '}
                  <a href="/refunds" className="text-primary hover:underline" target="_blank" rel="noreferrer">
                    Refund policy
                  </a>
                  . Card details are handled by Cashfree — they never reach our servers.
                </p>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
