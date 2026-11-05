'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

function safeNext(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const n = new URLSearchParams(window.location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard';
}

// "Continue with Google" — Firebase popup OAuth, then the same session exchange
// the email/password flows use. Works once the Google provider is enabled and
// the domain is authorized in the Firebase project.
//
// `disabled` exists so sign-up can gate this behind the terms checkbox. Without
// it the Google button would be a way around an acceptance the email/password
// form requires — and an account created that way would have no record of having
// agreed to anything.
export function GoogleAuthButton({
  label = 'Continue with Google',
  disabled = false,
  onBlockedClick,
  acceptedTerms = false,
}: {
  label?: string;
  disabled?: boolean;
  onBlockedClick?: () => void;
  // Set by sign-up only. Recorded against the organisation this login creates,
  // so a Google-created account carries the same acceptance evidence as one made
  // with the email form. Sign-in leaves it false: acceptance is taken once, from
  // whoever signs the org up, not re-taken on every login.
  acceptedTerms?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (disabled) {
      onBlockedClick?.();
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      const idToken = await cred.user.getIdToken();
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, acceptedTerms }),
      });
      // Two 403s are possible here. The invite-only gate is the expected one —
      // a Google account is trivial to create, so this is the door most
      // strangers arrive at. The unverified-email case should not happen at all
      // (Google verifies the address itself and its tokens carry
      // email_verified), but is handled so a provider that ever stopped doing
      // that fails legibly rather than as a generic "could not sign in".
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}) as { code?: string; error?: string });
        setError(
          body.code === 'invite_only'
            ? (body.error ?? 'This account does not have access yet.')
            : 'That Google account has no verified email address.',
        );
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error('session');
      router.push(safeNext());
      router.refresh();
    } catch (err: any) {
      const code: string = err?.code ?? '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // User dismissed the popup — not an error worth showing.
      } else if (code === 'auth/operation-not-allowed') {
        setError('Google sign-in isn’t enabled yet.');
      } else if (code === 'auth/unauthorized-domain') {
        setError('This domain isn’t authorized for Google sign-in.');
      } else {
        setError('Could not sign in with Google. Please try again.');
      }
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        // Not the `disabled` attribute when gated: a disabled button swallows the
        // click, so the user gets no explanation for why nothing happened.
        aria-disabled={disabled || undefined}
        className={`flex w-full items-center justify-center gap-2.5 rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition hover:border-primary/60 disabled:opacity-50 ${
          disabled ? 'opacity-50' : ''
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33Z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
        </svg>
        {loading ? 'Connecting…' : label}
      </button>
      {error && <p className="mt-2 text-center text-xs text-danger">{error}</p>}
    </div>
  );
}
