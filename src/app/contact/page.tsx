// Public contact page — required for Cashfree merchant activation alongside
// /terms, /privacy, and /refunds. Served at /contact; keep the URL stable.
//
import Link from 'next/link';
import { Mail, BookOpen, ReceiptText, Clock, MapPin } from 'lucide-react';
import { IntegrationEnquiryForm } from '@/components/IntegrationEnquiryForm';
import { RATE_PER_MINUTE_INR } from '@/lib/billing/catalogue';

export const metadata = {
  title: 'Contact us',
  description:
    'Tell us how your clinic takes calls today and what you want an AI receptionist to do. We will come back with what it takes to integrate VaaniYantra with the systems you already run.',
};

// The single front door. Every primary CTA on the marketing site now points
// here, and — because accounts are invite-only — this is also the only way for
// a new practice to get a login. It has to do two jobs at once: capture what a
// prospect needs, and stay the plain contact page that Cashfree's merchant
// activation requires alongside /terms, /privacy and /refunds. The form is
// first; the support, billing and business details it must publish sit below.
export default function ContactPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Tell us what you need</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        We set up each practice by hand, so we start by understanding yours — how calls are answered today, what
        your patients ring about, and which systems have to keep working. Tell us that and we&rsquo;ll come back
        within one working day with what it would take to integrate VaaniYantra, and what it would cost you at
        ₹{RATE_PER_MINUTE_INR} a minute.
      </p>

      <div className="mt-8">
        <IntegrationEnquiryForm />
      </div>

      <h2 className="mt-14 text-lg font-medium text-ink">Other ways to reach us</h2>
      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="flex items-center gap-2 text-ink">
            <Mail className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium">Support &amp; general enquiries</h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            For help with your agents, numbers, integrations, or anything else:
          </p>
          <a
            className="mt-2 inline-block text-sm font-medium text-primary underline"
            href="mailto:info@vaaniyantra.com"
          >
            info@vaaniyantra.com
          </a>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="flex items-center gap-2 text-ink">
            <ReceiptText className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium">Billing, cancellations &amp; refunds</h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Email us with your payment reference, or see the{' '}
            <a className="underline" href="/refunds">
              Refund &amp; Cancellation Policy
            </a>{' '}
            for how refunds work.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="flex items-center gap-2 text-ink">
            <Clock className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium">Response time</h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            We reply within 2 business days (Monday–Saturday, IST). Billing and account-access issues are prioritized.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="flex items-center gap-2 text-ink">
            <BookOpen className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium">Help yourself</h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Setup steps, integration guides, and FAQs live in the{' '}
            <Link className="underline" href="/docs">
              documentation
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="mt-8 space-y-2 text-sm leading-relaxed text-ink-soft">
        <h2 className="text-lg font-medium text-ink">Business details</h2>
        <p>
          VaaniYantra — AI voice agents for businesses, operating at{' '}
          <a className="underline" href="https://vaaniyantra.com">
            vaaniyantra.com
          </a>
          . Payments are processed by Cashfree Payments India Private Limited.
        </p>
        <p className="flex items-start gap-2">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            Registered address: 3-60 Balijipalem, Narsipatnam, Andhra Pradesh 531114, India
          </span>
        </p>
      </section>
    </main>
  );
}
