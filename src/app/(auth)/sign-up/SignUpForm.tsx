'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  type User,
} from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { authErrorMessage } from '@/lib/auth/error-messages';
import { GoogleAuthButton } from '@/components/GoogleAuthButton';
import { EmailVerification } from '@/components/EmailVerification';

function safeNext(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const n = new URLSearchParams(window.location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard'; // role-corrected by the dashboard guard
}

export function SignUpForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Acceptance of the Terms, Privacy Policy and DPA, and — the part that is not
  // boilerplate — the clinic acknowledging that telling its own patients is its
  // job. Our entire data-protection posture rests on the clinic being the Data
  // Fiduciary while we are the Processor, and that split is theoretical unless
  // the clinic actually gives patients notice. This is where we ask for it.
  const [accepted, setAccepted] = useState(false);
  // Set once the Firebase account exists and a code has been mailed. While this
  // holds a user, the form is replaced by the code step — the account is created
  // but has no session and no tenant behind it until the code is redeemed.
  const [pending, setPending] = useState<User | null>(null);

  function finish() {
    router.push(safeNext());
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accepted) {
      setError('Please accept the terms and the patient-notice responsibility to continue.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      // No session is minted here any more. The account exists in Firebase, but
      // it stays a shell — no cookie, no organisation, no workspace — until the
      // person proves they can read the address they typed. Handing out the
      // dashboard first and verifying later is exactly the bug this replaces.
      setPending(cred.user);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      // Almost always someone who started signing up, never entered the code,
      // and came back to try again. Their password is already set, so sign them
      // in and put them on the code step rather than telling them the address is
      // taken — by their own account, with no way to reach it.
      if (code === 'auth/email-already-in-use') {
        try {
          const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
          setPending(cred.user);
          return;
        } catch {
          // A wrong password here means the address really does belong to a
          // finished account, so the original message is the right one.
        }
      }
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (pending) {
    return (
      <EmailVerification
        user={pending}
        email={pending.email ?? email.trim()}
        // Carried through to the confirm route, which is now the request that
        // creates the organisation — so acceptance is stamped on the org exactly
        // once, by the party that signed up, just as before.
        acceptedTerms
        onVerified={finish}
        onCancel={() => {
          setPending(null);
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
      <h1 className="h-display text-2xl font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-muted">Start building AI voice agents in minutes.</p>

      <div className="mt-6">
        <GoogleAuthButton
          label="Sign up with Google"
          acceptedTerms={accepted}
          disabled={!accepted}
          onBlockedClick={() =>
            setError('Please accept the terms and the patient-notice responsibility to continue.')
          }
        />
      </div>
      <div className="my-5 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted">Name</label>
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
            placeholder="Jane Doe"
          />
        </div>
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
            placeholder="At least 6 characters"
          />
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-surface-2 p-3.5">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => {
              setAccepted(e.target.checked);
              if (e.target.checked) setError(null);
            }}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="text-xs leading-relaxed text-muted">
            I agree to the{' '}
            <Link href="/terms" target="_blank" className="text-ink underline underline-offset-2">
              Terms of Service
            </Link>
            ,{' '}
            <Link href="/privacy" target="_blank" className="text-ink underline underline-offset-2">
              Privacy Policy
            </Link>{' '}
            and{' '}
            <Link href="/dpa" target="_blank" className="text-ink underline underline-offset-2">
              Data Processing Addendum
            </Link>
            . If I use this service for patients, I confirm my practice is responsible for telling
            them an AI assistant handles our calls and messages and that their data is processed by
            our providers, including outside India —{' '}
            <Link
              href="/patient-notice"
              target="_blank"
              className="text-ink underline underline-offset-2"
            >
              wording I can use
            </Link>
            .
          </span>
        </label>

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
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/sign-in" className="text-ink underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
