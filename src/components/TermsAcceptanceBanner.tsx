'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// Shown in the app shell when the organisation has no acceptance on record for
// the current version of our legal documents.
//
// A banner, not a modal that locks the app. These are existing customers with
// patients waiting — holding their dashboard hostage over paperwork would be a
// worse trade than the day or two it takes them to click. It does not dismiss,
// so it stays until the acceptance is real.
//
// Rendered for OWNERs only. Accepting a DPA binds the practice as Data
// Fiduciary, so it has to come from someone who can commit it; the API enforces
// the same rule with org:manage. Everyone else sees nothing, because a banner a
// nurse cannot action is just noise on a clinical screen.
export function TermsAcceptanceBanner({ firstTime }: { firstTime: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/legal/accept', { method: 'POST' });
      if (!res.ok) throw new Error('failed');
      router.refresh();
    } catch {
      setError('Could not record that. Please try again, or contact us if it keeps failing.');
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-4">
      <h2 className="text-sm font-medium text-ink">
        {firstTime ? 'Please confirm our terms' : 'Our terms have been updated'}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
        {firstTime
          ? 'Your account was created before we asked customers to confirm this, so we have no record of your agreement.'
          : 'We have materially updated the documents that govern your use of the service.'}{' '}
        Please review our{' '}
        <Link href="/terms" target="_blank" className="underline underline-offset-2">
          Terms of Service
        </Link>
        ,{' '}
        <Link href="/privacy" target="_blank" className="underline underline-offset-2">
          Privacy Policy
        </Link>{' '}
        and{' '}
        <Link href="/dpa" target="_blank" className="underline underline-offset-2">
          Data Processing Addendum
        </Link>
        .
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        If you use this service for patients, confirming also means your practice is responsible for
        telling them an AI assistant handles your calls and messages, and that their data is
        processed by our providers including outside India. We publish{' '}
        <Link href="/patient-notice" target="_blank" className="underline underline-offset-2">
          wording you can use
        </Link>{' '}
        so that is a five-minute job.
      </p>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <button
        type="button"
        onClick={accept}
        disabled={busy}
        className="mt-3 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
      >
        {busy ? 'Recording…' : 'I agree on behalf of my practice'}
      </button>
    </div>
  );
}
