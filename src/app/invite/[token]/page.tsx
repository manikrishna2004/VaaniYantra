'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

type Info = { valid: boolean; email?: string; role?: string; orgName?: string };

export default function InvitePage(props: { params: Promise<{ token: string }> }) {
  const params = use(props.params);
  const router = useRouter();
  const { token } = params;
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<'idle' | 'joining' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const next = `/invite/${token}`;

  useEffect(() => {
    fetch(`/api/invitations/accept?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setSignedIn(!!user);
      if (!user) return;
      // Ensure the session cookie is fresh, then accept.
      try {
        const idToken = await user.getIdToken();
        await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        setStatus('joining');
        const res = await fetch('/api/invitations/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (res.ok) {
          // A doctor's first screen is their own setup, not a clinic dashboard
          // built for staff. Accepting the invite created their row with a
          // placeholder name; this is where they replace it.
          router.replace(data.role === 'DOCTOR' ? '/my-practice' : '/dashboard');
          router.refresh();
        } else {
          setStatus('error');
          setMessage(data.error || 'Could not accept the invitation.');
        }
      } catch {
        setStatus('error');
        setMessage('Something went wrong accepting the invitation.');
      }
    });
    return () => unsub();
  }, [token, router]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-7 text-center">
        <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-xl bg-primary text-lg font-bold text-on-primary">
          C
        </div>

        {info === null && <p className="text-sm text-muted">Loading invitation…</p>}

        {info && !info.valid && (
          <>
            <h1 className="h-display text-xl font-semibold">Invitation not found</h1>
            <p className="mt-1 text-sm text-muted">
              This invite link is invalid, revoked, or expired.
            </p>
            <Link href="/sign-in" className="mt-4 inline-block text-sm text-ink underline">
              Go to sign in
            </Link>
          </>
        )}

        {info?.valid && (
          <>
            <h1 className="h-display text-xl font-semibold">
              Join {info.orgName}
            </h1>
            <p className="mt-1 text-sm text-muted">
              You&apos;ve been invited as <span className="capitalize">{info.role?.toLowerCase()}</span>.
            </p>

            {status === 'joining' && (
              <p className="mt-5 text-sm text-muted">Joining…</p>
            )}

            {status === 'error' && (
              <div className="mt-5 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
                {message}
              </div>
            )}

            {signedIn === false && (
              <div className="mt-5 space-y-2">
                <p className="text-xs text-muted">
                  Sign in or create an account with <span className="text-ink">{info.email}</span>{' '}
                  to accept.
                </p>
                <Link
                  href={`/sign-up?next=${encodeURIComponent(next)}`}
                  className="block rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
                >
                  Create account
                </Link>
                <Link
                  href={`/sign-in?next=${encodeURIComponent(next)}`}
                  className="block rounded-xl border border-border px-4 py-2.5 text-sm text-ink transition hover:bg-surface-2"
                >
                  Sign in
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
