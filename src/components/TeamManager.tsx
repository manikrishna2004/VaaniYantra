'use client';

import { useEffect, useState, useCallback } from 'react';
import { CalendarCheck, CalendarX, Check, Mail, Send } from 'lucide-react';
import type { Role } from '@/lib/auth/permissions';

type Member = {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  isYou: boolean;
  // Whether they have connected their own Google Calendar.
  hasCalendar: boolean;
};
type Invitation = { id: string; email: string; role: Role; url: string };

// DOCTOR sits next to VIEWER rather than above it: it is a sideways role, not a
// rung on the staff ladder. Listing it first after VIEWER keeps the widening
// staircase readable while making it an obvious choice when inviting a clinician.
const ALL_ROLES: Role[] = ['VIEWER', 'DOCTOR', 'MEMBER', 'ADMIN', 'OWNER'];

const ROLE_HINTS: Partial<Record<Role, string>> = {
  DOCTOR: 'Sees and manages only their own calendar, hours and time off.',
};

function assignableRoles(yourRole: Role): Role[] {
  // Only owners can grant the owner role.
  return yourRole === 'OWNER' ? ALL_ROLES : ALL_ROLES.filter((r) => r !== 'OWNER');
}

export function TeamManager({ canManage, yourRole }: { canManage: boolean; yourRole: Role }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [mailerConfigured, setMailerConfigured] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const m = await fetch('/api/members').then((r) => r.json());
    setMembers(m.members ?? []);
    if (canManage) {
      const inv = await fetch('/api/invitations').then((r) => r.json());
      setInvites(inv.invitations ?? []);
      setMailerConfigured(Boolean(inv.mailerConfigured));
    }
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    setBusy(true);
    const res = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error || 'Could not create invite');
      return;
    }
    const invited = email;
    setEmail('');
    await load();
    if (data.emailed) {
      setSent(`Invitation emailed to ${invited}.`);
    } else {
      // No mail backend, or the send failed. The invite is still valid, so hand
      // the owner the link rather than leaving them with a dead end.
      copy(data.url);
      setSent(`Invite link for ${invited} copied — send it to them yourself.`);
    }
  }

  async function changeRole(userId: string, newRole: Role) {
    setError(null);
    const res = await fetch(`/api/members/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) setError((await res.json()).error || 'Could not change role');
    await load();
  }

  async function removeMember(userId: string) {
    setError(null);
    const res = await fetch(`/api/members/${userId}`, { method: 'DELETE' });
    if (!res.ok) setError((await res.json()).error || 'Could not remove member');
    await load();
  }

  async function revoke(id: string) {
    await fetch(`/api/invitations/${id}`, { method: 'DELETE' });
    await load();
  }

  function copy(url: string) {
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(url);
        setTimeout(() => setCopied(null), 2000);
      },
      () => {},
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {error}
        </div>
      )}
      {sent && (
        <div className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-3.5 py-2.5 text-sm text-success">
          <Check className="h-4 w-4 shrink-0" />
          {sent}
        </div>
      )}

      {canManage && (
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-sm font-medium text-ink">Invite a doctor or staff member</h2>
          <p className="mt-1 text-xs text-muted">
            {mailerConfigured
              ? 'We’ll email them an invitation. They join your practice after signing in with that address, then connect their own calendar so patients get booked with them.'
              : 'Email sending isn’t set up on this server, so you’ll get a link to send them yourself. They join after signing in with that address.'}
          </p>
          <form onSubmit={invite} className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="dr.mehta@clinic.com"
              className="min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm text-ink outline-none focus:border-primary"
            >
              {assignableRoles(yourRole).map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0) + r.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            {ROLE_HINTS[role] && (
              <p className="w-full text-xs text-muted">{ROLE_HINTS[role]}</p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
            >
              {mailerConfigured ? <Send className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
              {busy ? 'Sending…' : mailerConfigured ? 'Send invite' : 'Create invite'}
            </button>
          </form>
        </section>
      )}

      {canManage && invites.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-sm font-medium text-ink">Pending invitations</h2>
          <p className="mt-1 text-xs text-muted">
            Inviting the same person again issues a fresh link and stops the previous one working.
          </p>
          <ul className="mt-3 divide-y divide-border">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{inv.email}</div>
                  <div className="text-[11px] text-muted capitalize">{inv.role.toLowerCase()}</div>
                </div>
                <button
                  onClick={() => copy(inv.url)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted transition hover:text-ink"
                >
                  {copied === inv.url ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  onClick={() => revoke(inv.id)}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger/10"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">Members</h2>
        <p className="mt-1 text-xs text-muted">
          A doctor needs their own calendar connected before patients can be booked with them.
        </p>
        {!members && <div className="mt-3 text-sm text-muted">Loading…</div>}
        <ul className="mt-3 divide-y divide-border">
          {members?.map((m) => (
            <li key={m.membershipId} className="flex items-center gap-3 py-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-medium text-ink">
                {(m.name || m.email).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">
                  {m.name || m.email}
                  {m.isYou && <span className="ml-1.5 text-[11px] text-muted">(you)</span>}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  <span className="truncate">{m.email}</span>
                  {m.hasCalendar ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <CalendarCheck className="h-3 w-3" />
                      calendar connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <CalendarX className="h-3 w-3" />
                      {m.isYou ? 'connect your calendar' : 'no calendar yet'}
                    </span>
                  )}
                </div>
              </div>
              {canManage && !m.isYou ? (
                <>
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.userId, e.target.value as Role)}
                    className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
                  >
                    {assignableRoles(yourRole).map((r) => (
                      <option key={r} value={r}>
                        {r.charAt(0) + r.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeMember(m.userId)}
                    className="rounded-lg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger/10"
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs text-muted capitalize">
                  {m.role.toLowerCase()}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
