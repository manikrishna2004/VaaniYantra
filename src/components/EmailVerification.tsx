'use client';

import { useEffect, useRef, useState } from 'react';
import { signOut, type User } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

// The "enter the code we emailed you" step.
//
// Shared by sign-up and sign-in rather than living in either. Sign-in needs it
// because an abandoned sign-up leaves a real Firebase account with an unverified
// address: that user can no longer create the account (the email is taken) and
// can no longer sign in (the session route refuses them), so without this the
// only escape would be a support ticket.
//
// The ID token is minted fresh on every call instead of being held in state.
// Firebase ID tokens last an hour and this screen can sit open for longer while
// someone hunts for the email; a stale token would fail the exchange at the
// last step, after the user did everything right.

const RESEND_COOLDOWN_S = 60;

export function EmailVerification({
  user,
  email,
  acceptedTerms = false,
  onVerified,
  onCancel,
  // Skip the initial send when the caller already triggered one.
  alreadySent = false,
}: {
  user: User;
  email: string;
  acceptedTerms?: boolean;
  onVerified: () => void;
  onCancel: () => void;
  alreadySent?: boolean;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    alreadySent ? `We sent a 6-digit code to ${email}.` : null,
  );
  const [submitting, setSubmitting] = useState(false);
  // Reported by the server on send. Never hardcoded — see the start route.
  const [from, setFrom] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(alreadySent ? RESEND_COOLDOWN_S : 0);
  // React mounts effects twice in dev; without this the first visit asks for two
  // codes and the second trips the server's resend cooldown, showing a "please
  // wait" error to a user who has done nothing wrong.
  const requestedRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function complete(entered: string) {
    const idToken = await user.getIdToken(true);
    const res = await fetch('/api/auth/verify-email/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, code: entered, acceptedTerms }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? 'That code did not work. Please try again.');
      return false;
    }
    onVerified();
    return true;
  }

  async function send(isResend: boolean) {
    setError(null);
    setSending(true);
    try {
      const idToken = await user.getIdToken(true);
      const res = await fetch('/api/auth/verify-email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'We could not send the code. Please try again.');
        return;
      }
      // Already verified — there is nothing to type, so just finish.
      if (data.verified) {
        await complete('');
        return;
      }
      if (typeof data.from === 'string') setFrom(data.from);
      setNotice(
        isResend
          ? `A new code is on its way to ${email}.`
          : `We sent a 6-digit code to ${email}. It expires in 15 minutes.`,
      );
      setCooldown(RESEND_COOLDOWN_S);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (alreadySent || requestedRef.current) return;
    requestedRef.current = true;
    void send(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const entered = code.replace(/\D/g, '');
    if (entered.length !== 6) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setSubmitting(true);
    try {
      const done = await complete(entered);
      // Clear a rejected code so the next attempt starts from an empty box
      // rather than making the user select over a wrong number.
      if (!done) setCode('');
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Leaving the step signs the half-made account out of this browser, so the
  // form underneath is usable by someone else and a shared machine is not left
  // holding a live Firebase session for an account nobody finished.
  async function cancel() {
    await signOut(auth).catch(() => {});
    onCancel();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-7">
      <div className="mb-6 flex items-center gap-2.5">
        <img src="/logo.png" alt="VaaniYantra" className="h-9 w-auto" />
        <div className="h-display text-lg font-semibold">VaaniYantra</div>
      </div>
      <h1 className="h-display text-2xl font-semibold">Check your email</h1>
      <p className="mt-1 text-sm text-muted">
        Enter the 6-digit code we sent to <span className="text-ink">{email}</span> to finish
        setting up your account.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted">Verification code</label>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-center text-lg font-semibold tracking-[0.5em] text-ink outline-none focus:border-primary"
            placeholder="000000"
          />
        </div>

        {notice && !error && (
          <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-muted">
            {notice}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
        >
          {submitting ? 'Verifying…' : 'Verify and continue'}
        </button>
      </form>

      <div className="mt-5 flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={() => void send(true)}
          disabled={sending || cooldown > 0}
          className="text-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {sending ? 'Sending…' : cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
        </button>
        <button
          type="button"
          onClick={() => void cancel()}
          className="text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Use a different email
        </button>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-muted">
        Can&apos;t find it? Check your spam folder
        {from ? (
          <>
            {' '}
            — the code comes from <span className="text-ink">{from}</span>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}
