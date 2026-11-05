import Link from 'next/link';
import { cookies } from 'next/headers';
import { Check } from 'lucide-react';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { BuyForm } from '@/components/kit/BuyForm';
import { KIT_PRICE_INR, KIT_PRODUCT_NAME } from '@/lib/kit/purchase';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Buy the Starter Kit',
  description: 'One-off purchase. Your download link is emailed the moment payment clears.',
};

// The checkout step: name, email, pay.
//
// Kept to one screen with nothing to read. Everything that persuades is on
// /kit; a buyer who has clicked through has already decided, and anything else
// here is friction between them and the payment.

export default async function BuyPage() {
  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse">
      <MarketingNav authed={authed} accent="#8b7fff" />

      <section className="mx-auto max-w-lg px-5 py-14 lg:py-20">
        <Link
          href="/kit"
          className="text-sm text-muted-inverse transition-colors duration-fast hover:text-ink-inverse"
        >
          ← Back
        </Link>

        <h1 className="h-display mt-5 text-3xl font-semibold text-ink-inverse">
          {KIT_PRODUCT_NAME}
        </h1>

        <div className="mt-5 flex items-baseline gap-3">
          <span className="font-display text-4xl font-bold text-ink-inverse">₹{KIT_PRICE_INR}</span>
          <span className="text-sm text-muted-inverse">one-off · no subscription</span>
        </div>

        <ul className="mt-7 space-y-2.5 text-sm">
          {[
            'The complete server, prompt pack and connector guide',
            'Setup screen with step-by-step instructions built in',
            'Works with Twilio or Exotel',
            'Yours to keep and to run for your own business',
          ].map((line) => (
            <li key={line} className="flex gap-2.5 text-ink-inverse-soft">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary-on-dark" aria-hidden />
              {line}
            </li>
          ))}
        </ul>

        <BuyForm priceInr={KIT_PRICE_INR} />

        <p className="mt-8 text-center text-xs text-muted-inverse">
          By buying you agree to the{' '}
          <Link href="/terms" className="underline hover:text-ink-inverse">
            terms
          </Link>{' '}
          and the{' '}
          <Link href="/refunds" className="underline hover:text-ink-inverse">
            refund policy
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
