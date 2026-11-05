'use client';

import { useState } from 'react';
import { updateProfile, sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { useRouter } from 'next/navigation';
import type { Role } from '@/lib/auth/permissions';

export function AccountSettings({
  name,
  email,
  role,
}: {
  name: string | null;
  email: string;
  role: Role;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(name ?? '');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      if (auth.currentUser) await updateProfile(auth.currentUser, { displayName });
      await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: displayName }),
      });
      setNote('Saved.');
      router.refresh();
    } catch {
      setNote('Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword() {
    setNote(null);
    try {
      await sendPasswordResetEmail(auth, email);
      setNote(`Password reset email sent to ${email}.`);
    } catch {
      setNote('Could not send reset email.');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-sm font-medium text-ink">Profile</h2>
        <form onSubmit={saveName} className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Display name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Email</label>
            <input
              value={email}
              disabled
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-muted"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <span className="text-xs text-muted capitalize">Role: {role.toLowerCase()}</span>
            {note && <span className="text-xs text-muted">{note}</span>}
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-sm font-medium text-ink">Password</h2>
        <p className="mt-1 text-xs text-muted">
          We&apos;ll email you a secure link to set a new password.
        </p>
        <button
          onClick={resetPassword}
          className="mt-4 rounded-xl border border-border px-4 py-2.5 text-sm text-ink transition hover:bg-surface-2"
        >
          Send password reset email
        </button>
      </section>
    </div>
  );
}
