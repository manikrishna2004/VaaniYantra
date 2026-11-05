'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { authErrorMessage } from '@/lib/auth/error-messages';
import { GoogleAuthButton } from '@/components/GoogleAuthButton';
import { EmailVerification } from '@/components/EmailVerification';

// Safe internal redirect target from ?next=, defaulting to the dashboard.
function safeNext(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const n = new URLSearchParams(window.location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard';
}

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  // A Firebase session persisted in this browser from a previous visit. We
  // surface it as a choice instead of acting on it — see the effect below.
  const [existing, setExisting] = useState<User | null>(null);
  const [continuing, setContinuing] = useState(false);
  // Someone whose password is right but whose address was never verified — an
  // abandoned sign-up. They are shown the code step instead of an error they
  // could do nothing about.
  const [unverified, setUnverified] = useState<User | null>(null);

  async function handleForgot() {
    setError(null);
    setResetMsg(null);
    const target = email.trim();
    if (!target) {
      setError('Enter your email above first, then click “Forgot password?”.');
      return;
    }
    setResetting(true);
    try {
      await sendPasswordResetEmail(auth, target);
      setResetMsg(`Password reset link sent to ${target}. Check your inbox (and spam), then sign in with the new password.`);
    } catch (err: unknown) {
      setError(authErrorMessage(err));
    } finally {
      setResetting(false);
    }
  }

  // Firebase keeps its own session in this browser's IndexedDB, independent of
  // our httpOnly cookie and outliving it. This page used to notice that, mint a
  // fresh cookie and redirect straight to the dashboard — so anyone opening the
  // sign-in page was silently logged in as whoever used the browser last,
  // clearing cookies did not log you out, and there was no way to reach the
  // form to use a different account.
  //
  // Surface it as an explicit choice instead. Convenience is preserved (one
  // click, no password) without ever authenticating someone who did not ask to
  // be authenticated.
  //
  // Note what reaching this component already means: page.tsx verified the
  // session cookie server-side and did NOT redirect, so there is no live app
  // session. A Firebase session found here is therefore the genuinely ambiguous
  // case — a stale login in this browser, not a signed-in user — and it is
  // exactly the one that must stay a choice rather than an automatic redirect.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setExisting(user));
    return () => unsub();
  }, []);

  // Establish the cookie for the already-signed-in Firebase user, on request.
  async function continueAsExisting() {
    if (!existing) return;
    setError(null);
    setContinuing(true);
    try {
      const idToken = await existing.getIdToken(true);
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (res.status === 403) {
        setContinuing(false);
        // Two different 403s live here. One says "finish verifying your
        // address", the other says "this address is not let in yet" — sending a
        // refused visitor to the code step would loop them through a
        // verification that cannot end in a session.
        const body = await res.json().catch(() => ({}) as { code?: string; error?: string });
        if (body.code === 'invite_only') {
          setError(body.error ?? 'This account does not have access yet.');
          return;
        }
        setUnverified(existing);
        return;
      }
      if (!res.ok) throw new Error('session');
      router.replace(safeNext());
      router.refresh();
    } catch {
      setError('That session has expired. Please sign in again.');
      await signOut(auth).catch(() => {});
      setExisting(null);
      setContinuing(false);
    }
  }

  // Drop the persisted Firebase session so the form is usable for someone else.
  async function useDifferentAccount() {
    await signOut(auth).catch(() => {});
    await fetch('/api/auth/session', { method: 'DELETE' }).catch(() => {});
    setExisting(null);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const idToken = await cred.user.getIdToken();
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      // The password was right, the address was never proved. Finish the
      // verification they abandoned rather than refusing a correct password —
      // unless the refusal is the invite-only gate, which no amount of
      // verifying will get past.
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}) as { code?: string; error?: string });
        if (body.code === 'invite_only') {
          setError(body.error ?? 'This account does not have access yet.');
          return;
        }
        setUnverified(cred.user);
        return;
      }
      if (!res.ok) throw new Error('session');
      router.push(safeNext());
      router.refresh();
    } catch (err: unknown) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (unverified) {
    return (
      <EmailVerification
        user={unverified}
        email={unverified.email ?? email.trim()}
        // Not passed on sign-in: acceptance was taken once, from whoever signed
        // the organisation up, and is never re-taken on a later login.
        onVerified={() => {
          router.push(safeNext());
          router.refresh();
        }}
        onCancel={() => {
          setUnverified(null);
          setExisting(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-7">
      <div className="mb-6 flex items-center gap-2.5">
        <img src="/logo.png" alt="VaaniYantra" className="h-9 w-auto" />
        <div className="h-display text-lg font-semibold">VaaniYantra</div>
      </div>
      <h1 className="h-display text-2xl font-semibold">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your account.</p>

      {existing && (
        <div className="mt-6 rounded-xl border border-border bg-surface-2 p-4">
          <p className="text-sm text-ink">
            You&apos;re already signed in as{' '}
            <span className="font-medium">{existing.email ?? existing.displayName ?? 'this account'}</span>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={continueAsExisting}
              disabled={continuing}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
            >
              {continuing ? 'Continuing…' : 'Continue'}
            </button>
            <button
              type="button"
              onClick={useDifferentAccount}
              disabled={continuing}
              className="rounded-xl border border-border-strong px-4 py-2 text-sm text-ink transition hover:border-primary/60 disabled:opacity-50"
            >
              Use a different account
            </button>
          </div>
        </div>
      )}

      <div className="mt-6">
        <GoogleAuthButton label="Sign in with Google" />
      </div>
      <div className="my-5 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted">Email</label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
            placeholder="you@company.com"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted">Password</label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
            placeholder="••••••••"
          />
          <div className="mt-1.5 text-right">
            <button
              type="button"
              onClick={handleForgot}
              disabled={resetting}
              className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
            >
              {resetting ? 'Sending…' : 'Forgot password?'}
            </button>
          </div>
        </div>

        {resetMsg && (
          <div className="rounded-xl border border-success/30 bg-success/10 px-3.5 py-2.5 text-sm text-success">
            {resetMsg}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        Don&apos;t have an account?{' '}
        <Link href="/contact" className="text-ink underline-offset-2 hover:underline">
          Talk to us
        </Link>
      </p>
    </div>
  );
}
