'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Button, Badge, Input, Field, Select, Spinner } from '@/components/ui';
import { useConfirm, useToast } from '@/components/Feedback';
import { WhatsappConnect } from '@/components/WhatsappConnect';

// SMS is not a per-org connector, and WhatsApp is only optionally one: the
// platform's shared Meta Cloud number sends every org's confirmations,
// reminders and owner alerts out of the box, with SMS as an automatic fallback.
// A clinic that wants its OWN WhatsApp identity can connect a number through
// Meta Embedded Signup (see WhatsappConnect) — that is an upgrade, not a
// required setup step, and the page is worded to keep that clear. Otherwise
// this page surfaces Google Calendar and HubSpot CRM. (Google Drive was
// removed; exporting data is a CSV download from Reports.)
type Conn = { connected: boolean; email: string | null; calendarId: string | null };
type WhatsappStatus = {
  available: boolean;
  appId: string | null;
  configId: string | null;
  graphVersion: string | null;
  connected: boolean;
  verifiedName: string | null;
  displayPhone: string | null;
};
type Status = {
  googleOAuthConfigured: boolean;
  canReadOrg: boolean;
  canManageOrg: boolean;
  google: Conn;
  hubspot: { connected: boolean };
  myCalendar: Conn;
  whatsapp: WhatsappStatus;
};
type Cal = { id: string; summary: string; primary: boolean };

const ERR: Record<string, string> = {
  state_mismatch: 'Security check failed — please try connecting again.',
  no_refresh_token: 'Google didn’t return a refresh token. Remove VaaniYantra from your Google account’s connected apps, then reconnect.',
  exchange_failed: 'Could not complete the Google connection.',
  access_denied: 'You declined the permission request.',
};

export function ConnectorsManager({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [cals, setCals] = useState<Cal[]>([]);
  const [myCals, setMyCals] = useState<Cal[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [hsToken, setHsToken] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  async function load() {
    const s = await fetch('/api/connectors').then((r) => r.json());
    setStatus(s);
    if (s.google?.connected) {
      fetch('/api/integrations/google/calendars')
        .then((r) => (r.ok ? r.json() : { calendars: [] }))
        .then((d) => setCals(d.calendars ?? []))
        .catch(() => {});
    }
    if (s.myCalendar?.connected) {
      fetch('/api/integrations/google/calendars?target=me')
        .then((r) => (r.ok ? r.json() : { calendars: [] }))
        .then((d) => setMyCals(d.calendars ?? []))
        .catch(() => {});
    }
  }

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const connected = p.get('connected');
    if (connected) {
      setNotice({
        kind: 'ok',
        text: connected === 'me' ? 'Your calendar is connected.' : 'The clinic calendar is connected.',
      });
    }
    const e = p.get('error');
    if (e) setNotice({ kind: 'err', text: ERR[e] ?? `Connection failed (${e}).` });
    if (connected || e) window.history.replaceState({}, '', '/connectors');
    load();
  }, []);

  type Target = 'org' | 'me';

  async function setCalendar(calendarId: string, target: Target = 'org') {
    setBusy(true);
    await fetch(`/api/integrations/google?target=${target}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId }),
    });
    setBusy(false);
    setStatus((s) =>
      !s
        ? s
        : target === 'me'
          ? { ...s, myCalendar: { ...s.myCalendar, calendarId } }
          : { ...s, google: { ...s.google, calendarId } },
    );
  }

  async function disconnectGoogle(target: Target = 'org') {
    const mine = target === 'me';
    if (
      !(await confirm({
        title: mine ? 'Disconnect your calendar?' : 'Disconnect the clinic calendar?',
        message: mine
          ? 'Your patients will be booked on the clinic’s shared calendar instead, until you reconnect.'
          : 'Your agents will stop being able to check availability or book appointments until you reconnect.',
        confirmLabel: 'Disconnect',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    await fetch(`/api/integrations/google?target=${target}`, { method: 'DELETE' });
    setBusy(false);
    if (mine) setMyCals([]);
    else setCals([]);
    await load();
  }

  async function connectHubspot() {
    setBusy(true);
    const res = await fetch('/api/connectors/hubspot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: hsToken.trim() }),
    });
    setBusy(false);
    if (res.ok) {
      setHsToken('');
      toast('HubSpot connected.', 'success');
      await load();
    } else {
      const b = await res.json().catch(() => ({}));
      toast(b.error || 'Could not connect HubSpot.', 'error');
    }
  }

  async function disconnectHubspot() {
    if (!(await confirm({ title: 'Disconnect HubSpot?', message: 'Calls will stop syncing to your CRM.', confirmLabel: 'Disconnect', danger: true }))) return;
    setBusy(true);
    await fetch('/api/connectors/hubspot', { method: 'DELETE' });
    setBusy(false);
    await load();
  }

  if (!status) return <Spinner />;

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`rounded-xl border px-4 py-2.5 text-sm ${notice.kind === 'ok' ? 'border-success/40 text-success' : 'border-danger/40 text-danger'}`}>
          {notice.text}
        </div>
      )}

      {/* Notifications work with no setup; the card below is the optional upgrade. */}
      <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-xs text-muted">
        Booking confirmations, reminders, and owner alerts are sent automatically over
        <span className="text-ink"> WhatsApp</span> from the platform — no setup needed.
      </div>

      {status.whatsapp?.available && (
        <WhatsappConnect
          {...status.whatsapp}
          canManage={canManage && status.canManageOrg}
          onChange={load}
        />
      )}

      {/* Your own calendar. First, because for a doctor it is the only card on
          this page that is theirs to act on. */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-ink">Your calendar</h3>
            <p className="mt-0.5 text-xs text-muted">
              Connect your own Google Calendar and your patients get booked on it — with your real availability and
              your days off.
            </p>
          </div>
          {status.myCalendar.connected ? (
            <Badge tone="success">connected</Badge>
          ) : (
            <Badge tone="neutral">not connected</Badge>
          )}
        </div>

        {!status.googleOAuthConfigured ? (
          <p className="text-xs text-muted">Google isn’t set up on the server yet.</p>
        ) : status.myCalendar.connected ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">{status.myCalendar.email ?? 'Your Google account'}</span>
              <Button size="sm" variant="ghost" onClick={() => disconnectGoogle('me')} disabled={busy}>
                Disconnect
              </Button>
            </div>
            <Field label="Your calendar" hint="Appointments booked with you are created here.">
              <Select
                value={status.myCalendar.calendarId ?? 'primary'}
                onChange={(e) => setCalendar(e.target.value, 'me')}
                disabled={busy || myCals.length === 0}
              >
                {myCals.length === 0 && <option value={status.myCalendar.calendarId ?? 'primary'}>Primary</option>}
                {myCals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary}
                    {c.primary ? ' (primary)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-muted">
              Ask whoever set up your agent to list you under <span className="text-ink">Doctors &amp; consultants</span>{' '}
              and pick your name, so bookings are routed here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Button onClick={() => (window.location.href = '/api/integrations/google/connect?target=me')}>
              Connect my calendar
            </Button>
            <p className="text-xs text-muted">
              Until you do, appointments with you go on the clinic’s shared calendar.
            </p>
          </div>
        )}
      </Card>

      {/* The clinic-wide calendar. Admins only. */}
      {status.canReadOrg && (
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-ink">Clinic calendar</h3>
              <p className="mt-0.5 text-xs text-muted">
                The shared calendar used for any booking not tied to a specific doctor.
              </p>
            </div>
            {status.google.connected ? <Badge tone="success">connected</Badge> : <Badge tone="neutral">not connected</Badge>}
          </div>

          {!status.googleOAuthConfigured ? (
            <p className="text-xs text-muted">Google isn’t set up on the server yet (admin sets GOOGLE_OAUTH_CLIENT_ID/SECRET).</p>
          ) : status.google.connected ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-ink">{status.google.email ?? 'Google account'}</span>
                {canManage && (
                  <Button size="sm" variant="ghost" onClick={() => disconnectGoogle('org')} disabled={busy}>
                    Disconnect
                  </Button>
                )}
              </div>
              <Field label="Target calendar" hint="New appointment events are created here.">
                <Select
                  value={status.google.calendarId ?? 'primary'}
                  onChange={(e) => setCalendar(e.target.value, 'org')}
                  disabled={!canManage || busy || cals.length === 0}
                >
                  {cals.length === 0 && <option value={status.google.calendarId ?? 'primary'}>Primary</option>}
                  {cals.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.summary}
                      {c.primary ? ' (primary)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="text-xs text-muted">
                VaaniYantra only ever reads and writes calendars &mdash; it has no access to this account&rsquo;s Drive,
                mail or contacts. To get your data out, download a CSV from{' '}
                <Link href="/reports" className="text-primary">
                  Reports
                </Link>
                .
              </p>
            </div>
          ) : canManage ? (
            <Button onClick={() => (window.location.href = '/api/integrations/google/connect?target=org')}>
              Connect the clinic calendar
            </Button>
          ) : (
            <p className="text-sm text-muted">Ask an admin to connect the clinic calendar.</p>
          )}
        </Card>
      )}

      {/* HubSpot CRM — org-wide, so hidden from a member who can't read it. */}
      {status.canReadOrg && (
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-ink">HubSpot CRM</h3>
            <p className="mt-0.5 text-xs text-muted">
              After each completed call, add the caller as a Contact and log a call note in HubSpot.
            </p>
          </div>
          {status.hubspot.connected ? <Badge tone="success">connected</Badge> : <Badge tone="neutral">not connected</Badge>}
        </div>

        {status.hubspot.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-ink">Private App token connected · calls sync to HubSpot</span>
            {canManage && (
              <Button size="sm" variant="ghost" onClick={disconnectHubspot} disabled={busy}>
                Disconnect
              </Button>
            )}
          </div>
        ) : canManage ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[240px]">
              <Field
                label="HubSpot Private App token"
                hint="HubSpot → Settings → Integrations → Private Apps → create one with CRM contacts scopes. Stored encrypted."
              >
                <Input type="password" value={hsToken} onChange={(e) => setHsToken(e.target.value)} placeholder="pat-…" />
              </Field>
            </div>
            <Button onClick={connectHubspot} disabled={busy || hsToken.trim().length < 20}>
              {busy ? <Spinner /> : 'Connect'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">Ask an admin to connect HubSpot.</p>
        )}
      </Card>
      )}
    </div>
  );
}
