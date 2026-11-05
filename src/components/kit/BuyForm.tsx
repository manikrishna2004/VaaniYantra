'use client';

import { useState } from 'react';
import { openCashfreeCheckout } from '@/lib/cashfree-client';

/**
 * Name and email, then straight to Cashfree.
 *
 * The email is not optional and not merely a lead capture: it is the buyer's
 * only identity here. There is no account, so it is where the receipt and the
 * download link go, and the only way to re-issue a link when they lose it.
 * That is worth saying on the form, because a required email with no stated
 * purpose reads as a mailing-list tax and costs conversions.
 */
export function BuyForm({ priceInr }: { priceInr: number }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);

    try {
      const res = await fetch('/api/kit/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Could not start the payment.');
        setBusy(false);
        return;
      }

      // Redirects away; nothing after this runs on success.
      await openCashfreeCheckout('order', data.paymentSessionId, data.environment);
    } catch {
      setError('Could not reach the payment page. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8">
      <label htmlFor="kit-name" className="block text-sm text-ink-inverse-soft">
        Your name
      </label>
      <input
        id="kit-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoComplete="name"
        className="mt-1.5 w-full rounded-xl border border-border-inverse-strong bg-surface-inverse-2 px-4 py-3 text-ink-inverse outline-none placeholder:text-muted-inverse focus:border-transparent focus:outline focus:outline-2 focus:outline-primary-on-dark"
        placeholder="Ravi Kumar"
      />

      <label htmlFor="kit-email" className="mt-5 block text-sm text-ink-inverse-soft">
        Email
      </label>
      <input
        id="kit-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
        className="mt-1.5 w-full rounded-xl border border-border-inverse-strong bg-surface-inverse-2 px-4 py-3 text-ink-inverse outline-none placeholder:text-muted-inverse focus:border-transparent focus:outline focus:outline-2 focus:outline-primary-on-dark"
        placeholder="you@example.com"
      />
      <p className="mt-2 text-xs text-muted-inverse">
        Your download link and receipt go here. It is also how we re-send the link if you lose it, so
        use an address you will still have in a year.
      </p>

      {error && (
        <p className="mt-5 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-ink-inverse">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-7 w-full rounded-xl bg-primary-on-dark px-8 py-4 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90 disabled:opacity-60"
      >
        {busy ? 'Taking you to payment…' : `Pay ₹${priceInr} and download`}
      </button>

      <p className="mt-4 text-center text-xs text-muted-inverse">
        Payment is handled by Cashfree. We never see your card details.
      </p>
    </form>
  );
}
