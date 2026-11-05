'use client';

import { useEffect, useState } from 'react';
import { Card, Button, Badge, Input, Select, Spinner, EmptyState, Field } from '@/components/ui';
import { useConfirm } from '@/components/Feedback';
import { isValidPhoneNumber } from '@/lib/utils';

type Stats = { total: number; completed: number; lastCallAt: string | null; avgDurationSec: number };
type Num = {
  id: string;
  e164: string;
  label: string | null;
  provider: string;
  providerSid: string | null;
  agentId: string | null;
  agent: { id: string; name: string } | null;
  callerIdName: string | null;
  forwardTo: string | null;
  inboundEnabled: boolean;
  webhookConfigured: boolean;
  whatsappEnabled: boolean;
  stats?: Stats;
};
type Agent = { id: string; name: string };
type AvailableNum = { e164: string; providerSid: string; voiceUrl?: string };
type TwilioAccount = {
  id: string;
  label: string;
  accountSid: string;
  isDefault: boolean;
  numberCount: number;
  createdAt: string;
};
type PlivoAccount = {
  id: string;
  label: string;
  authId: string;
  isDefault: boolean;
  numberCount: number;
  createdAt: string;
};
type ExotelAccount = {
  id: string;
  label: string;
  accountSid: string;
  subdomain: string;
  appUrl: string | null;
  isDefault: boolean;
  numberCount: number;
  createdAt: string;
};

// Providers offered when ADDING a number.
type Provider = 'twilio' | 'plivo' | 'exotel';

const PROVIDER_LABEL: Record<Provider, string> = {
  twilio: 'Twilio',
  plivo: 'Plivo',
  exotel: 'Exotel',
};

// Exotel is the odd one out and stays that way on purpose: ExoPhones cannot be
// listed or bought through a generic provisioning API, its numbers are often
// written in local format (04045901102) rather than E.164, and inbound needs a
// Voicebot applet pointed at our WebSocket by hand — see ExotelSetupGuide.
const isExotel = (p: Provider) => p === 'exotel';

type ConnectedAccount = TwilioAccount | PlivoAccount | ExotelAccount;
/** The id each console shows: Account SID for Twilio/Exotel, Auth ID for Plivo. */
const accountIdOf = (a: ConnectedAccount) => ('authId' in a ? a.authId : a.accountSid);

export function NumbersManager({
  whatsappEnabled = false,
  canManage = true,
}: {
  whatsappEnabled?: boolean;
  /** number:write — owner-only. False renders the list read-only. */
  canManage?: boolean;
}) {
  const [numbers, setNumbers] = useState<Num[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [openId, setOpenId] = useState<string | null>(null);

  // "Add a number" wizard state. Default to Plivo (the low-cost recommended provider).
  const [provider, setProvider] = useState<Provider>('plivo');
  const [e164, setE164] = useState('');
  const [label, setLabel] = useState('');
  const [available, setAvailable] = useState<AvailableNum[] | null>(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [setupNote, setSetupNote] = useState<string | null>(null);

  // Connected BYO accounts.
  const [twilioAccounts, setTwilioAccounts] = useState<TwilioAccount[]>([]);
  const [plivoAccounts, setPlivoAccounts] = useState<PlivoAccount[]>([]);
  const [exotelAccounts, setExotelAccounts] = useState<ExotelAccount[]>([]);
  const [twilioAcctId, setTwilioAcctId] = useState('');
  const [plivoAcctId, setPlivoAcctId] = useState('');
  const [exotelAcctId, setExotelAcctId] = useState('');

  async function load() {
    const [n, a, tw, pl, ex] = await Promise.all([
      fetch('/api/numbers').then((r) => r.json()),
      fetch('/api/agents').then((r) => r.json()),
      fetch('/api/twilio-accounts').then((r) => r.json()).catch(() => ({ accounts: [] })),
      fetch('/api/plivo-accounts').then((r) => r.json()).catch(() => ({ accounts: [] })),
      fetch('/api/exotel-accounts').then((r) => r.json()).catch(() => ({ accounts: [] })),
    ]);
    setNumbers(n);
    setAgents(a.map((x: any) => ({ id: x.id, name: x.name })));
    const twList: TwilioAccount[] = tw.accounts ?? [];
    setTwilioAccounts(twList);
    setTwilioAcctId((p) => p || twList.find((x) => x.isDefault)?.id || twList[0]?.id || '');
    const plList: PlivoAccount[] = pl.accounts ?? [];
    setPlivoAccounts(plList);
    setPlivoAcctId((p) => p || plList.find((x) => x.isDefault)?.id || plList[0]?.id || '');
    const exList: ExotelAccount[] = ex.accounts ?? [];
    setExotelAccounts(exList);
    setExotelAcctId((p) => p || exList.find((x) => x.isDefault)?.id || exList[0]?.id || '');
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const accountsFor = (p: Provider) =>
    p === 'twilio' ? twilioAccounts : p === 'plivo' ? plivoAccounts : exotelAccounts;
  const selectedAccountId =
    provider === 'twilio' ? twilioAcctId : provider === 'plivo' ? plivoAcctId : exotelAcctId;
  const setSelectedAccountId =
    provider === 'twilio' ? setTwilioAcctId : provider === 'plivo' ? setPlivoAcctId : setExotelAcctId;
  const hasAccount = accountsFor(provider).length > 0;

  function switchProvider(p: Provider) {
    setProvider(p);
    setAvailable(null);
    setError(null);
    setSetupNote(null);
    setE164('');
    setLabel('');
  }

  // ── Number operations ──
  async function addManual() {
    // ExoPhones are frequently written in local format (e.g. 04045901102), which
    // is a valid Exotel number but not valid E.164 — so only the providers that
    // genuinely require E.164 are held to it.
    if (!isExotel(provider) && !isValidPhoneNumber(e164)) {
      setError('Enter the number with country code, e.g. +919876543210');
      return;
    }
    if (isExotel(provider) && !e164.trim()) {
      setError('Enter your ExoPhone number.');
      return;
    }
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> =
      provider === 'plivo'
        ? { provider: 'plivo', e164, label: label || null, plivoAccountId: plivoAcctId }
        : provider === 'exotel'
          ? { provider: 'exotel', e164: e164.trim(), label: label || null, exotelAccountId: exotelAcctId }
          : { e164, label: label || null };
    const res = await fetch('/api/numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b?.error?.formErrors?.[0] ?? b?.error ?? 'Failed to add number');
      return;
    }
    setE164('');
    setLabel('');
    await load();
  }

  async function findNumbers() {
    setLoadingAvail(true);
    setError(null);
    setAvailable(null);
    const params = new URLSearchParams({ provider });
    if (selectedAccountId) params.set('accountId', selectedAccountId);
    const res = await fetch(`/api/numbers/available?${params}`).then((r) => r.json());
    setLoadingAvail(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setAvailable(res.numbers ?? []);
  }

  async function importNumber(n: AvailableNum) {
    setBusy(true);
    const body: Record<string, unknown> =
      provider === 'plivo'
        ? { provider: 'plivo', e164: n.e164, providerSid: n.providerSid, plivoAccountId: plivoAcctId }
        : provider === 'exotel'
          ? {
              provider: 'exotel',
              e164: n.e164,
              providerSid: n.providerSid,
              exotelAccountId: exotelAcctId,
              // Lets the server backfill the account's outbound App URL from the
              // ExoPhone's own VoiceUrl, so outbound works without hunting for it.
              voiceUrl: n.voiceUrl,
            }
          : { e164: n.e164, providerSid: n.providerSid, twilioAccountId: twilioAcctId || undefined };
    await fetch('/api/numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    setAvailable((a) => (a ? a.filter((x) => x.e164 !== n.e164) : a));
    await load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/numbers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await load();
  }

  async function toggleWhatsapp(id: string, enable: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/numbers/${id}/whatsapp`, { method: enable ? 'POST' : 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b?.error ?? 'Could not update WhatsApp for this number.');
      return;
    }
    await load();
  }

  async function configureWebhook(id: string) {
    setBusy(true);
    setSetupNote(null);
    const res = await fetch(`/api/numbers/${id}/configure`, { method: 'POST' });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(b?.error ?? 'Failed to configure webhook');
      return;
    }
    if (b?.manual && b?.instruction) setSetupNote(b.instruction);
    await load();
  }

  async function remove(id: string, e: string) {
    if (
      !(await confirm({
        title: `Remove number ${e}?`,
        message: 'This only unlinks it here; it is not released at the provider.',
        confirmLabel: 'Remove',
        danger: true,
      }))
    )
      return;
    await fetch(`/api/numbers/${id}`, { method: 'DELETE' });
    setNumbers((n) => n.filter((x) => x.id !== id));
  }

  // ── BYO account operations (both providers) ──
  async function connectTwilio(input: { label: string; accountSid: string; authToken: string }) {
    const res = await fetch('/api/twilio-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: (await res.json().catch(() => ({})))?.error ?? 'Failed to connect' };
    await load();
    return { ok: true as const };
  }
  async function connectPlivo(input: { label: string; authId: string; authToken: string }) {
    const res = await fetch('/api/plivo-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: (await res.json().catch(() => ({})))?.error ?? 'Failed to connect' };
    await load();
    return { ok: true as const };
  }
  async function connectExotel(input: {
    label: string;
    accountSid: string;
    apiKey: string;
    apiToken: string;
    subdomain: string;
    appUrl: string;
  }) {
    const res = await fetch('/api/exotel-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: (await res.json().catch(() => ({})))?.error ?? 'Failed to connect' };
    await load();
    return { ok: true as const };
  }
  async function setDefaultAccount(kind: Provider, id: string) {
    await fetch(`/api/${kind}-accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    await load();
  }
  async function disconnectAccount(kind: Provider, id: string, label: string) {
    if (
      !(await confirm({
        title: `Disconnect ${PROVIDER_LABEL[kind]} account "${label}"?`,
        message: 'Your numbers stay listed, but management falls back until you reconnect.',
        confirmLabel: 'Disconnect',
        danger: true,
      }))
    )
      return;
    await fetch(`/api/${kind}-accounts/${id}`, { method: 'DELETE' });
    // Clear the selection for the provider we just disconnected — not whichever
    // one the old two-way branch happened to fall through to.
    ({ twilio: setTwilioAcctId, plivo: setPlivoAcctId, exotel: setExotelAcctId })[kind]('');
    await load();
  }

  const readyCount = numbers.filter((n) => n.agentId).length;

  return (
    <div className="space-y-6">
      {/* Short status line (the page wrapper already renders the title). */}
      {numbers.length > 0 && (
        <p className="text-sm text-muted">
          You have <span className="text-ink">{numbers.length}</span> number{numbers.length === 1 ? '' : 's'}
          {readyCount > 0 && <> · <span className="text-success">{readyCount} live</span></>}. Assign an agent to a
          number so callers reach it.
        </p>
      )}

      {/* Your numbers — the primary content, shown first */}
      {loading ? (
        <Card className="flex justify-center py-10"><Spinner /></Card>
      ) : numbers.length === 0 ? (
        <EmptyState
          title="No numbers yet"
          description="Add your first number below, then assign an agent so it can take calls."
        />
      ) : (
        <div className="space-y-3">
          {numbers.map((n) => (
            <NumberRow
              key={n.id}
              n={n}
              agents={agents}
              open={openId === n.id}
              busy={busy}
              onToggle={() => setOpenId(openId === n.id ? null : n.id)}
              onAssign={(agentId) => patch(n.id, { agentId })}
              onPatch={patch}
              onConfigure={configureWebhook}
              onToggleWhatsapp={(enable) => toggleWhatsapp(n.id, enable)}
              whatsappEnabled={whatsappEnabled}
              onRemove={() => remove(n.id, n.e164)}
            />
          ))}
        </div>
      )}

      {/* Add a number — guided, provider-first. Owner-only: everything in here
          attaches a carrier account or buys a number, and the API refuses all
          of it below number:write, so showing it to staff would only produce
          buttons that 403. */}
      {canManage ? (
        <Card>
        <h2 className="text-sm font-semibold text-ink">Add a number</h2>
        <p className="mt-0.5 mb-4 text-[12px] text-muted">
          Pick where your number lives, connect that account once, then add the number.
        </p>

        {/* Step 1 — provider */}
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              { id: 'plivo', name: 'Plivo', blurb: 'Connect your Plivo account and import your numbers — set up automatically.' },
              { id: 'twilio', name: 'Twilio', blurb: 'Connect your Twilio account and import your numbers — set up automatically.' },
              { id: 'exotel', name: 'Exotel', blurb: 'India/APAC ExoPhones. Import your numbers, then point the Voicebot applet at us once.' },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              onClick={() => switchProvider(p.id)}
              className={`rounded-xl border p-3.5 text-left transition ${
                provider === p.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-surface-2 hover:border-border-strong'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{p.name}</span>
                {provider === p.id && <Badge tone="accent">selected</Badge>}
              </div>
              <p className="mt-1 text-[11px] text-muted">{p.blurb}</p>
            </button>
          ))}
        </div>

        {/* Step 2 — connect account (only if none yet) */}
        <div className="mt-5 border-t border-border pt-5">
          {!hasAccount ? (
            provider === 'twilio' ? (
              <TwilioConnectForm onConnect={connectTwilio} />
            ) : provider === 'plivo' ? (
              <PlivoConnectForm onConnect={connectPlivo} />
            ) : (
              <ExotelConnectForm onConnect={connectExotel} />
            )
          ) : (
            <>
              {/* Account selector + manage */}
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-[240px]">
                  <label className="label">{PROVIDER_LABEL[provider]} account</label>
                  <Select
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="sm:max-w-xs"
                  >
                    {accountsFor(provider).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label} ({accountIdOf(a).slice(0, 8)}…)
                        {a.isDefault ? ' · default' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              {/* Step 3 — get a number */}
              <div className="rounded-xl border border-border bg-surface-2 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={findNumbers} disabled={loadingAvail}>
                    {loadingAvail ? <Spinner /> : isExotel(provider) ? 'Find my ExoPhones' : `Find my ${PROVIDER_LABEL[provider]} numbers`}
                  </Button>
                  <span className="text-[11px] text-muted">
                    Import a number you already own on this account.
                  </span>
                </div>

                {/* Available list */}
                {available !== null && (
                  <div className="mt-3 space-y-2">
                    {available.length === 0 ? (
                      <p className="text-xs text-muted">
                        No un-imported numbers found. Buy a number in your {PROVIDER_LABEL[provider]} console, then find it here — or add one manually below.
                      </p>
                    ) : (
                      available.map((n) => (
                        <div
                          key={n.e164}
                          className="flex items-center justify-between rounded-lg border border-border bg-surface px-3.5 py-2.5"
                        >
                          <span className="text-sm text-ink">{n.e164}</span>
                          <Button size="sm" onClick={() => importNumber(n)} disabled={busy}>
                            Import
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Manual add */}
                <div className="mt-4 border-t border-border pt-4">
                  <label className="label">Or add manually</label>
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Input
                      value={e164}
                      onChange={(e) => setE164(e.target.value)}
                      placeholder={isExotel(provider) ? '04045901102 or +914045901102' : '+919876543210'}
                    />
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
                    <Button variant="secondary" onClick={addManual} disabled={busy}>
                      {busy ? <Spinner /> : 'Add'}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Manage connected accounts (compact, secondary) */}
              <ConnectedAccounts
                provider={provider}
                accounts={accountsFor(provider)}
                onSetDefault={(id) => setDefaultAccount(provider, id)}
                onDisconnect={(id, l) => disconnectAccount(provider, id, l)}
                onConnectTwilio={connectTwilio}
                onConnectPlivo={connectPlivo}
                onConnectExotel={connectExotel}
              />
            </>
          )}
        </div>

        {setupNote && (
          <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-xs text-ink">
            <span className="font-medium">Setup: </span>
            {setupNote}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Card>
      ) : (
        <Card>
          <p className="text-sm text-muted">
            Phone numbers are managed by the practice owner. Ask them to connect a number, or to change which
            agent an existing one routes to.
          </p>
        </Card>
      )}
    </div>
  );
}

// ── A single number in the list ──
function NumberRow({
  n,
  agents,
  open,
  busy,
  onToggle,
  onAssign,
  onPatch,
  onConfigure,
  onToggleWhatsapp,
  whatsappEnabled,
  onRemove,
}: {
  n: Num;
  agents: Agent[];
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onAssign: (agentId: string) => void;
  onPatch: (id: string, body: Record<string, unknown>) => Promise<void>;
  onConfigure: (id: string) => Promise<void>;
  onToggleWhatsapp: (enable: boolean) => void;
  whatsappEnabled?: boolean;
  onRemove: () => void;
}) {
  // Twilio and Plivo both fetch a per-call answer webhook we point at the platform.
  const usesWebhook = n.provider === 'twilio' || n.provider === 'plivo';
  // A number is "live" when it has an agent and can receive calls.
  const live = !!n.agentId && n.inboundEnabled && (!usesWebhook || n.webhookConfigured);

  // Everything the user still has to do before this number takes AI calls — shown
  // right on the card so nothing required is hidden.
  const todos: string[] = [];
  if (!n.agentId) todos.push('Assign an agent (dropdown on the right) so it knows what to say.');
  if (!n.inboundEnabled) todos.push('Turn on “Accept inbound calls” in Settings.');
  if (usesWebhook && !n.webhookConfigured) {
    todos.push('Point the number’s webhook to the platform (Settings → “Point webhook to platform”).');
  }
  if (n.provider === 'exotel') {
    todos.push(
      'In the Exotel dashboard, point this number’s Voicebot applet at our WebSocket (open Settings for the exact URL to copy).',
    );
    todos.push('Send a test call from Settings to confirm the agent answers.');
  }

  return (
    <Card className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{n.e164}</span>
            <Badge tone="neutral">{n.provider}</Badge>
            {live ? (
              <Badge tone="success">● live</Badge>
            ) : !n.agentId ? (
              <Badge tone="neutral">needs an agent</Badge>
            ) : !n.inboundEnabled ? (
              <Badge tone="danger">inbound off</Badge>
            ) : (
              <Badge tone="neutral">needs setup</Badge>
            )}
            {n.forwardTo && <Badge tone="accent">→ {n.forwardTo}</Badge>}
            {whatsappEnabled && n.whatsappEnabled && <Badge tone="success">WhatsApp</Badge>}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {n.label ?? 'No label'} · {n.stats?.total ?? 0} calls
            {n.stats?.completed ? ` · ${n.stats.completed} completed` : ''}
            {n.stats?.lastCallAt ? ` · last ${new Date(n.stats.lastCallAt).toLocaleDateString()}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={n.agentId ?? ''} onChange={(e) => onAssign(e.target.value)} className="w-44">
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Button variant="secondary" size="sm" onClick={onToggle}>
            {open ? 'Close' : 'Settings'}
          </Button>
          <Button variant="danger" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>

      {/* Surface every remaining step, right on the card. */}
      {!live && todos.length > 0 && (
        <div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-warning">To go live, finish these steps:</span>
            {!open && (
              <button className="text-[11px] text-primary hover:underline" onClick={onToggle}>
                Open setup
              </button>
            )}
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-ink-soft">
            {todos.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <NumberSettings n={n} onPatch={onPatch} onConfigure={onConfigure} onToggleWhatsapp={onToggleWhatsapp} whatsappEnabled={whatsappEnabled} busy={busy} />
      )}
    </Card>
  );
}

// ── Connected accounts (compact list + add-another) ──
function ConnectedAccounts({
  provider,
  accounts,
  onSetDefault,
  onDisconnect,
  onConnectTwilio,
  onConnectPlivo,
  onConnectExotel,
}: {
  provider: Provider;
  accounts: ConnectedAccount[];
  onSetDefault: (id: string) => void;
  onDisconnect: (id: string, label: string) => void;
  onConnectTwilio: (i: { label: string; accountSid: string; authToken: string }) => Promise<{ ok?: true; error?: string }>;
  onConnectPlivo: (i: { label: string; authId: string; authToken: string }) => Promise<{ ok?: true; error?: string }>;
  onConnectExotel: (i: {
    label: string;
    accountSid: string;
    apiKey: string;
    apiToken: string;
    subdomain: string;
    appUrl: string;
  }) => Promise<{ ok?: true; error?: string }>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const rows = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    sid: accountIdOf(a),
    isDefault: a.isDefault,
    count: a.numberCount,
  }));

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Connected {PROVIDER_LABEL[provider]} accounts
        </span>
        <button className="text-[11px] text-primary hover:underline" onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? 'Cancel' : '+ Connect another'}
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {rows.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">{a.label}</span>
              <Badge>{a.sid.slice(0, 10)}…</Badge>
              {a.isDefault && <Badge tone="success">default</Badge>}
              <span className="text-[11px] text-muted">{a.count} number{a.count === 1 ? '' : 's'}</span>
            </div>
            <div className="flex items-center gap-2">
              {!a.isDefault && (
                <Button variant="secondary" size="sm" onClick={() => onSetDefault(a.id)}>
                  Make default
                </Button>
              )}
              <Button variant="danger" size="sm" onClick={() => onDisconnect(a.id, a.label)}>
                Disconnect
              </Button>
            </div>
          </div>
        ))}
      </div>
      {showAdd && (
        <div className="mt-3">
          {provider === 'twilio' ? (
            <TwilioConnectForm onConnect={onConnectTwilio} />
          ) : provider === 'plivo' ? (
            <PlivoConnectForm onConnect={onConnectPlivo} />
          ) : (
            <ExotelConnectForm onConnect={onConnectExotel} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Twilio connect form ──
function TwilioConnectForm({
  onConnect,
}: {
  onConnect: (i: { label: string; accountSid: string; authToken: string }) => Promise<{ ok?: true; error?: string }>;
}) {
  const [label, setLabel] = useState('');
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!accountSid.trim() || !authToken.trim()) {
      setErr('Account SID and Auth Token are required.');
      return;
    }
    setBusy(true);
    const res = await onConnect({ label: label.trim(), accountSid: accountSid.trim(), authToken: authToken.trim() });
    setBusy(false);
    if (res.error) return setErr(res.error);
    setLabel(''); setAccountSid(''); setAuthToken('');
  }

  return (
    <div>
      <p className="mb-3 text-[12px] text-muted">
        Connect your Twilio account once — find the SID &amp; Auth Token on your Twilio Console dashboard.{' '}
        <a href="/docs/user-guide" target="_blank" className="text-primary underline">Setup guide</a>
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Label" hint="A name to recognise this account.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Acme Twilio" />
        </Field>
        <Field label="Account SID">
          <Input value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="AC…" />
        </Field>
        <Field label="Auth Token" hint="Stored encrypted; never shown again.">
          <Input type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="Twilio auth token" />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : 'Connect Twilio'}
        </Button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

// ── Plivo connect form ──
function PlivoConnectForm({
  onConnect,
}: {
  onConnect: (i: { label: string; authId: string; authToken: string }) => Promise<{ ok?: true; error?: string }>;
}) {
  const [label, setLabel] = useState('');
  const [authId, setAuthId] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!authId.trim() || !authToken.trim()) {
      setErr('Auth ID and Auth Token are required.');
      return;
    }
    setBusy(true);
    const res = await onConnect({ label: label.trim(), authId: authId.trim(), authToken: authToken.trim() });
    setBusy(false);
    if (res.error) return setErr(res.error);
    setLabel(''); setAuthId(''); setAuthToken('');
  }

  return (
    <div>
      <p className="mb-3 text-[12px] text-muted">
        Connect your Plivo account once — find the Auth ID &amp; Auth Token on your Plivo Console overview.{' '}
        <a href="/docs/user-guide" target="_blank" className="text-primary underline">Setup guide</a>
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Label" hint="A name to recognise this account.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Acme Plivo" />
        </Field>
        <Field label="Auth ID">
          <Input value={authId} onChange={(e) => setAuthId(e.target.value)} placeholder="MA… / SA…" />
        </Field>
        <Field label="Auth Token" hint="Stored encrypted; never shown again.">
          <Input type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="Plivo auth token" />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : 'Connect Plivo'}
        </Button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

// ── Exotel connect form ──
// Exotel needs more than a SID/token pair: the API key and token are a separate
// credential from the Account SID, and the region subdomain is per-account (an
// India account on api.in.exotel.com will 404 against the default host). The
// App URL is optional because only OUTBOUND needs it — inbound works without.
function ExotelConnectForm({
  onConnect,
}: {
  onConnect: (i: {
    label: string;
    accountSid: string;
    apiKey: string;
    apiToken: string;
    subdomain: string;
    appUrl: string;
  }) => Promise<{ ok?: true; error?: string }>;
}) {
  const [label, setLabel] = useState('');
  const [accountSid, setAccountSid] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [subdomain, setSubdomain] = useState('api.in.exotel.com');
  const [appUrl, setAppUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!accountSid.trim() || !apiKey.trim() || !apiToken.trim()) {
      setErr('Account SID, API Key and API Token are required.');
      return;
    }
    setBusy(true);
    const res = await onConnect({
      label: label.trim(),
      accountSid: accountSid.trim(),
      apiKey: apiKey.trim(),
      apiToken: apiToken.trim(),
      subdomain: subdomain.trim(),
      appUrl: appUrl.trim(),
    });
    setBusy(false);
    if (res.error) return setErr(res.error);
    setLabel(''); setAccountSid(''); setApiKey(''); setApiToken(''); setAppUrl('');
  }

  return (
    <div>
      <p className="mb-3 text-[12px] text-muted">
        Connect your Exotel account once — find the API Key &amp; Token in Exotel &rarr; Settings &rarr; API.{' '}
        <a href="/docs/user-guide" target="_blank" className="text-primary underline">Setup guide</a>
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Label" hint="A name to recognise this account.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Acme Exotel" />
        </Field>
        <Field label="Account SID">
          <Input value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="your-exotel-sid" />
        </Field>
        <Field label="API Key">
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Exotel API key" />
        </Field>
        <Field label="API Token" hint="Stored encrypted; never shown again.">
          <Input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="Exotel API token" />
        </Field>
        <Field label="Subdomain" hint="Your region host, no scheme.">
          <Input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="api.in.exotel.com" />
        </Field>
        <Field label="Outbound App URL" hint="Optional — only outbound calls need it.">
          <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://my.exotel.com/…/start_voice" />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : 'Connect Exotel'}
        </Button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

function NumberSettings({
  n,
  onPatch,
  onConfigure,
  onToggleWhatsapp,
  whatsappEnabled,
  busy,
}: {
  n: Num;
  onPatch: (id: string, body: Record<string, unknown>) => Promise<void>;
  onConfigure: (id: string) => Promise<void>;
  onToggleWhatsapp: (enable: boolean) => void;
  whatsappEnabled?: boolean;
  busy: boolean;
}) {
  const [label, setLabel] = useState(n.label ?? '');
  const [callerIdName, setCallerIdName] = useState(n.callerIdName ?? '');
  const [forwardTo, setForwardTo] = useState(n.forwardTo ?? '');
  const [inboundEnabled, setInboundEnabled] = useState(n.inboundEnabled);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (forwardTo && !isValidPhoneNumber(forwardTo)) {
      setErr('Enter the forwarding number with country code, e.g. +91 98765 43210');
      return;
    }
    await onPatch(n.id, { label, callerIdName, forwardTo, inboundEnabled });
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(null), 1500);
  }

  return (
    <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
      <Field label="Label">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sales line" />
      </Field>
      <Field label="Caller ID name" hint="Friendly name shown for outbound calls.">
        <Input value={callerIdName} onChange={(e) => setCallerIdName(e.target.value)} placeholder="e.g. VaaniYantra Sales" />
      </Field>
      <Field label="Forward inbound to" hint="If set, inbound calls go straight to this number (no AI agent).">
        <Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="+919876543210" />
      </Field>
      <Field label="Inbound calls">
        <label className="flex items-center gap-2 pt-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={inboundEnabled}
            onChange={(e) => setInboundEnabled(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Accept inbound calls to this number
        </label>
      </Field>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={busy}>
          Save settings
        </Button>
        {(n.provider === 'twilio' || n.provider === 'plivo') && (
          <Button variant="secondary" size="sm" onClick={() => onConfigure(n.id)} disabled={busy}>
            {n.webhookConfigured ? 'Re-point webhook to platform' : 'Point webhook to platform'}
          </Button>
        )}
        {savedMsg && <span className="text-xs text-success">{savedMsg}</span>}
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>

      {/* WhatsApp on this number (Twilio/Exotel/Plivo; hidden while the platform is SMS-only) */}
      {whatsappEnabled && (n.provider === 'twilio' || n.provider === 'exotel' || n.provider === 'plivo') && (
        <div className="sm:col-span-2 mt-2 rounded-xl border border-border bg-surface-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-ink">WhatsApp</h4>
              <p className="mt-0.5 text-[12px] text-muted">
                Use <span className="text-ink">{n.e164}</span> to send WhatsApp confirmations, reminders and owner
                alerts through your {n.provider === 'twilio' ? 'Twilio' : n.provider === 'plivo' ? 'Plivo' : 'Exotel'} account.
              </p>
            </div>
            {n.whatsappEnabled ? (
              <div className="flex items-center gap-2">
                <Badge tone="success">WhatsApp on</Badge>
                <Button variant="secondary" size="sm" onClick={() => onToggleWhatsapp(false)} disabled={busy}>
                  Turn off
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => onToggleWhatsapp(true)} disabled={busy}>
                Use for WhatsApp
              </Button>
            )}
          </div>
          <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-ink-soft">
            This number must already be <span className="text-ink">WhatsApp-enabled in your{' '}
            {n.provider === 'twilio' ? 'Twilio' : n.provider === 'plivo' ? 'Plivo' : 'Exotel'} account</span> (a one-time
            WhatsApp Business approval on the provider’s side). Once it is, turning this on routes all WhatsApp messages
            through it.
          </p>
        </div>
      )}

      {n.provider === 'exotel' && <ExotelSetupGuide n={n} />}
    </div>
  );
}

// ── Guided Exotel setup: copy-paste the WebSocket URL into the Voicebot applet,
// then send a test call to confirm the whole path works. ──

// Module scope on purpose. Defined inside ExotelSetupGuide's body this was a new
// component *type* on every render, so React tore down and remounted both copy
// rows on each keystroke in the test-call field below.
function CopyRow({
  label,
  value,
  hint,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  hint?: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink">{label}</span>
        <button onClick={onCopy} className="text-[11px] text-primary hover:underline" disabled={!value}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <code className="mt-1 block truncate rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-soft">
        {value || '…'}
      </code>
      {hint && <p className="mt-0.5 text-[10px] text-muted">{hint}</p>}
    </div>
  );
}

function ExotelSetupGuide({ n }: { n: Num }) {
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  const wssUrl = origin ? origin.replace(/^https?:\/\//, 'wss://') + '/exotel' : '';
  const dynamicUrl = origin ? `${origin}/api/telephony/exotel/stream` : '';

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }

  async function sendTest() {
    setTestMsg(null);
    if (!isValidPhoneNumber(testTo)) {
      setTestMsg({ ok: false, text: 'Enter your mobile with country code, e.g. +91 98765 43210' });
      return;
    }
    setTesting(true);
    const res = await fetch(`/api/numbers/${n.id}/test-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: testTo }),
    });
    const b = await res.json().catch(() => ({}));
    setTesting(false);
    setTestMsg(
      res.ok
        ? { ok: true, text: 'Calling your phone now — answer it and you should hear your agent.' }
        : { ok: false, text: b?.error ?? 'Test call failed.' },
    );
  }

  return (
    <div className="sm:col-span-2 mt-2 rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink">Connect this number to your agent (one-time)</h4>
        <span className="text-[11px] text-muted">
          {n.stats?.total ? `✓ ${n.stats.total} call${n.stats.total === 1 ? '' : 's'} received` : 'No calls yet'}
        </span>
      </div>
      <ol className="mt-3 space-y-2 text-[12px] text-ink-soft">
        <li>
          <span className="text-muted">1.</span> Open{' '}
          <a href="https://my.exotel.com" target="_blank" rel="noreferrer" className="text-primary underline">
            Exotel → App Bazaar
          </a>{' '}
          and create (or edit) the call flow assigned to <span className="text-ink">{n.e164}</span>.
        </li>
        <li>
          <span className="text-muted">2.</span> Add the <span className="text-ink">Voicebot</span> applet (bidirectional).
          If it isn’t listed, ask Exotel to enable it on your account.
        </li>
        <li>
          <span className="text-muted">3.</span> Paste this into the applet’s <span className="text-ink">URL</span>, leave
          Sample Rate at <span className="text-ink">8000</span>, and save:
        </li>
      </ol>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <CopyRow
          label="WebSocket URL (static)"
          value={wssUrl}
          hint="Simplest — paste directly."
          copied={copied === 'wss'}
          onCopy={() => copy(wssUrl, 'wss')}
        />
        <CopyRow
          label="Dynamic URL (recommended)"
          value={dynamicUrl}
          hint="Survives server moves — no future dashboard edits."
          copied={copied === 'dyn'}
          onCopy={() => copy(dynamicUrl, 'dyn')}
        />
      </div>
      <ol className="mt-3 space-y-2 text-[12px] text-ink-soft" start={4}>
        <li>
          <span className="text-muted">4.</span> Assign that flow to <span className="text-ink">{n.e164}</span> for
          incoming calls, and make sure this number has an agent assigned above.
        </li>
      </ol>

      {/* Verify with a real call */}
      <div className="mt-4 border-t border-border pt-3">
        <label className="label">Test it — we’ll call your phone and connect the agent</label>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Your mobile e.g. +919876543210" />
          <Button size="sm" onClick={sendTest} disabled={testing}>
            {testing ? <Spinner /> : 'Send test call'}
          </Button>
        </div>
        {testMsg && (
          <p className={`mt-2 text-xs ${testMsg.ok ? 'text-success' : 'text-danger'}`}>{testMsg.text}</p>
        )}
      </div>
    </div>
  );
}
