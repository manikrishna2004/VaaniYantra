// Public refund & cancellation policy — required for Cashfree merchant
// activation (RBI norms expect Terms, Privacy, Refund/Cancellation, and
// Contact pages on the merchant site). Served at /refunds; keep the URL stable.

export const metadata = {
  title: 'Refund & Cancellation Policy',
  description: 'How cancellations, refunds, and billing disputes work at VaaniYantra.',
};

const UPDATED = 'August 28, 2026';

export default function RefundsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Refund &amp; Cancellation Policy</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

      <section className="mt-8 space-y-6 text-sm leading-relaxed text-ink-soft">
        <p>
          This policy explains how cancellations, refunds, and billing disputes work for VaaniYantra. It supplements
          our <a className="underline" href="/terms">Terms of Service</a>.
        </p>
        <p>
          We sell two different things, and they work differently here. The <strong>managed service</strong> — where
          we run the agents for you — is billed by usage, and everything up to &ldquo;Disputing a usage charge&rdquo;
          below is about that. The <strong>Starter Kit</strong> is a one-off download that you run yourself, with no
          usage billing at all; skip to{' '}
          <a className="underline" href="#one-off">One-off digital products</a> for that.
        </p>

        <h2 className="text-lg font-medium text-ink">How you are charged for the managed service</h2>
        <p>
          The managed service is billed by usage, in Indian Rupees (₹). You pay a single per-minute rate for the minutes your
          agents actually spend on calls, invoiced after the end of each month. There is no subscription fee, no
          minimum and no advance payment, so there is nothing to cancel and nothing held on account. The rate that
          applies to you is shown on <strong>Settings → Billing</strong> in your dashboard, alongside the minutes
          recorded so far this month.
        </p>
        <p>
          Nothing is charged before the service is delivered: a minute is only billable once the call has happened
          and been recorded in your call log, which you can inspect at any time.
        </p>

        <h2 className="text-lg font-medium text-ink">Monthly plans (existing customers)</h2>
        <p>
          Some accounts opened before August 2026 are on a monthly plan we no longer sell. Those customers keep that
          plan and its price for as long as they wish, and the rest of this section applies to them. Paid plans are
          billed monthly in advance through our payment partner, Cashfree Payments. Your dashboard shows which of the
          two arrangements applies to your account, and the date your current paid period ends:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>One month at a time.</strong> You pay for a single month and nothing is charged automatically.
            We remind you in the dashboard before the month runs out, and your plan continues only if you choose to
            renew.
          </li>
          <li>
            <strong>Automatic renewal.</strong> If you set up a recurring mandate (UPI Autopay, e-NACH, or a card
            standing instruction), the plan renews each month until you cancel. You receive a pre-debit notification
            before every renewal charge, as required by RBI rules.
          </li>
        </ul>

        <h2 className="text-lg font-medium text-ink">Cancelling</h2>
        <p>
          You can cancel at any time from <strong>Settings → Billing</strong> in your dashboard, or by emailing{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>
          . On usage billing there is nothing to cancel in advance: stop placing calls, or ask us to switch your
          agents off, and the final invoice covers only the minutes already used. On a monthly plan, cancellation
          takes effect at the end of the current billing period — you keep your plan&rsquo;s features and minutes
          until then, no further renewals are charged, and any payment mandate (such as UPI Autopay) is cancelled. In
          both cases your agents, call history, and settings are kept.
        </p>

        <h2 className="text-lg font-medium text-ink">Refunds</h2>
        <p>
          Charges are for call minutes that have already been delivered, so they are generally non-refundable — and
          on a monthly plan we do not prorate partial months. We do issue a full refund when:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>you were charged twice for the same billing period (duplicate payment);</li>
          <li>you were charged but the subscription failed to activate on your account; or</li>
          <li>a billing error on our side charged you the wrong amount (refund of the difference).</li>
        </ul>
        <p>
          To request a refund, email{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>{' '}
          from your account email with the payment reference. We respond within 2 business days.
        </p>

        <h2 className="text-lg font-medium text-ink">How refunds are paid</h2>
        <p>
          Approved refunds are made to the original payment method through Cashfree. Refunds are initiated within 2
          business days of approval and typically reach your account in 5–7 business days, depending on your bank or
          UPI provider.
        </p>

        <h2 className="text-lg font-medium text-ink">Disputing a usage charge</h2>
        <p>
          Every billed minute corresponds to a call in your call log, with its date, duration and transcript. If you
          believe a usage charge is wrong, contact us within 7 days of the invoice and we will go through the call
          logs with you and correct any error. The same applies to overage on the older monthly plans, where minutes
          past the plan&rsquo;s allowance are billed at that plan&rsquo;s overage rate after the month ends.
        </p>

        {/* The Starter Kit is a one-off download, not the metered service the
            rest of this page describes: nothing per-minute, nothing to cancel,
            no call log to reconcile. It is paid through the same Cashfree
            account, but as a `vkt_` order that belongs to no organization, so
            there is no invoice or credit note — the refund goes straight back
            against that order. */}
        <h2 id="one-off" className="scroll-mt-24 text-lg font-medium text-ink">
          One-off digital products
        </h2>
        <p>
          The <a className="underline" href="/kit">Voice Agent Starter Kit</a> is a single purchase, not a
          subscription. There is no per-minute charge, no recurring payment and nothing to cancel: you download the
          files once and they are yours to keep and to run for your own business.
        </p>
        <p>
          It runs on your own machine using your own accounts with the services it connects to, so any phone,
          messaging or AI charges are billed to you by those providers directly. We never see those accounts and
          cannot bill, refund or credit anything on them.
        </p>
        <p>
          Because the full contents are delivered immediately on payment, please read the product page and its
          requirements before buying. If the kit does not work as described there, email us within{' '}
          <strong>14 days</strong> of purchase and we will refund it in full. Refunds for the kit are returned to the original
          payment method, and there is nothing further for you to do.
        </p>

        <h2 className="text-lg font-medium text-ink">Contact</h2>
        <p>
          Billing questions, cancellations, or refund requests:{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>
          . See also our <a className="underline" href="/contact">contact page</a>.
        </p>
      </section>
    </main>
  );
}
