'use client';

import { useEffect, useState } from 'react';
import { PageHeader, Card, Button, Badge, Input, Field, Select, Spinner, Textarea } from '@/components/ui';
import { useConfirm } from '@/components/Feedback';
import { TeamCallCalendarCard } from '@/components/TeamCallCalendarCard';
import {
  ORG_PERIODS,
  matchesOrgFilters,
  periodLabel,
  type AdminOrgRow,
  type OrgPeriod,
} from '@/lib/admin-orgs';

type Plan = {
  key: string;
  name: string;
  product?: 'bundle' | 'voice' | 'chat';
  legacy?: boolean;
  priceMonthly: number;
  contactSales?: boolean;
  pricePerMinute?: number;
  overagePerMinute?: number;
  limits: Record<string, number>;
};

const LIMIT_FIELDS: { key: string; label: string }[] = [
  { key: 'agents', label: 'Agents' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'callMinutesPerMonth', label: 'Call min / mo' },
  { key: 'knowledgeDocs', label: 'Docs' },
  { key: 'chatbots', label: 'Chatbots' },
  { key: 'chatConversationsPerMonth', label: 'Chats / mo' },
];
type PlanEdit = { priceMonthly: string } & Record<string, string>;
// The row shape is defined once, next to the query that builds it, so this
// table and the CSV export cannot drift apart.
type Org = AdminOrgRow;
type PromoRow = {
  id: string;
  code: string;
  description: string | null;
  percentOff: number | null;
  fixedPriceInr: number | null;
  plans: string | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: string | null;
  active: boolean;
};
type Data = {
  stats: {
    orgs: number;
    users: number;
    workspaces: number;
    agents: number;
    callsThisMonth: number;
    minutesThisMonth: number;
    byPlan: { plan: string; count: number }[];
  };
  orgs: Org[];
  plans: Plan[];
  secrets: { geminiSet: boolean; geminiHint: string | null };
  cashfree: {
    configured: boolean;
    appId: string;
    live: boolean;
    secretSet: boolean;
    environment: string;
    subscriptionsEnabled: boolean;
    internationalEnabled: boolean;
    mode: 'subscription' | 'order';
  };
  whatsapp: {
    featureEnabled?: boolean;
    configured: boolean;
    appId: string;
    secretSet: boolean;
    configId: string;
    verifySet: boolean;
    graphVersion: string;
    chatAddonPriceInr: number;
    wabaId: string;
    systemTokenSet: boolean;
    defaultPhoneNumberId: string;
  };
  config: {
    liveModel: string;
    liveVoice: string;
    liveSilenceMs: number;
    liveTemperature: number;
    typingSound: boolean;
    geminiModel: string;
    systemPromptBase: string | null;
    systemPromptDefault: string;
    callGuidance: string;
    callGuidanceDefault: string;
  };
};

export function AdminDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [geminiKey, setGeminiKey] = useState('');
  const [planEdits, setPlanEdits] = useState<Record<string, PlanEdit>>({});
  const [cashfree, setCashfree] = useState({
    appId: '',
    secretKey: '',
    environment: 'sandbox',
    subscriptionsEnabled: false,
    internationalEnabled: false,
  });
  const [meta, setMeta] = useState({ appId: '', appSecret: '', configId: '', verifyToken: '', graphVersion: '', chatAddonPriceInr: '', wabaId: '', systemUserToken: '', defaultPhoneNumberId: '' });
  const [cfg, setCfg] = useState({ liveModel: '', liveVoice: '', liveSilenceMs: '', liveTemperature: '', geminiModel: '', systemPromptBase: '', callGuidance: '', typingSound: false });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Who is allowed to create an account at all (src/lib/access.ts).
  const [access, setAccess] = useState<{ inviteOnly: boolean; allowlist: string } | null>(null);
  // Org table controls. `period` changes what is COUNTED so it goes to the
  // server; the rest only change what is SHOWN, so they filter in the browser.
  const [period, setPeriod] = useState<OrgPeriod>('month');
  const [fPlan, setFPlan] = useState('all');
  const [fStatus, setFStatus] = useState('all');
  const [fNumbers, setFNumbers] = useState<'all' | 'with' | 'without'>('all');
  const [fAgents, setFAgents] = useState<'all' | 'with' | 'without'>('all');
  const [waTemplates, setWaTemplates] = useState<Array<{ name: string; status: string }> | null>(null);
  const [waTmplNote, setWaTmplNote] = useState<string | null>(null);
  // Only used to show the founder the exact webhook URL to paste into Cashfree.
  const [origin, setOrigin] = useState('');
  const [promos, setPromos] = useState<PromoRow[]>([]);
  const [tax, setTax] = useState({ enabled: false, gstin: '', rate: '18', legalName: '', address: '' });
  const [revenue, setRevenue] = useState<{
    invoices: number; collectedInr: number; taxCollectedInr: number; estGatewayFeeInr: number; estNetInr: number;
  } | null>(null);
  const [promoForm, setPromoForm] = useState({
    code: '', description: '', percentOff: '', fixedPriceInr: '', plans: '', maxRedemptions: '', expiresInDays: '',
  });
  const confirm = useConfirm();
  // #4: the exact assembled prompt + params, fetched on demand.
  const [preview, setPreview] = useState<{ systemText: string; params: Record<string, unknown> } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function loadPreview() {
    setPreviewing(true);
    try {
      const p = await fetch('/api/admin/prompt-preview').then((r) => r.json());
      if (p?.systemText) setPreview({ systemText: p.systemText, params: p.params });
    } finally {
      setPreviewing(false);
    }
  }

  async function load(p: OrgPeriod) {
    const d = await fetch(`/api/admin?period=${p}`).then((r) => r.json());
    setData(d);
    const fin = (n: number) => (Number.isFinite(n) ? String(n) : '');
    const pe: Record<string, PlanEdit> = {};
    for (const pl of (d.plans ?? []) as Plan[]) {
      pe[pl.key] = {
        priceMonthly: String(pl.priceMonthly),
        pricePerMinute: pl.pricePerMinute != null ? String(pl.pricePerMinute) : '',
        overagePerMinute: pl.overagePerMinute != null ? String(pl.overagePerMinute) : '',
        agents: fin(pl.limits.agents),
        workspaces: fin(pl.limits.workspaces),
        callMinutesPerMonth: fin(pl.limits.callMinutesPerMonth),
        knowledgeDocs: fin(pl.limits.knowledgeDocs),
      };
    }
    setPlanEdits(pe);
    if (d.cashfree)
      setCashfree((s) => ({
        ...s,
        appId: d.cashfree.appId,
        environment: d.cashfree.environment || 'sandbox',
        subscriptionsEnabled: Boolean(d.cashfree.subscriptionsEnabled),
        internationalEnabled: Boolean(d.cashfree.internationalEnabled),
      }));
    if (d.whatsapp)
      setMeta((s) => ({
        ...s,
        appId: d.whatsapp.appId,
        configId: d.whatsapp.configId,
        graphVersion: d.whatsapp.graphVersion || '',
        chatAddonPriceInr: d.whatsapp.chatAddonPriceInr ? String(d.whatsapp.chatAddonPriceInr) : '',
        wabaId: d.whatsapp.wabaId || '',
        defaultPhoneNumberId: d.whatsapp.defaultPhoneNumberId || '',
      }));
    if (d.config)
      setCfg({
        liveModel: d.config.liveModel ?? '',
        liveVoice: d.config.liveVoice ?? '',
        liveSilenceMs: String(d.config.liveSilenceMs ?? ''),
        liveTemperature: String(d.config.liveTemperature ?? ''),
        geminiModel: d.config.geminiModel ?? '',
        systemPromptBase: d.config.systemPromptBase ?? '',
        callGuidance: d.config.callGuidance ?? '',
        typingSound: Boolean(d.config.typingSound),
      });
  }
  async function loadAccess() {
    const r = await fetch('/api/admin/access').then((x) => x.json()).catch(() => null);
    if (r) setAccess({ inviteOnly: Boolean(r.inviteOnly), allowlist: (r.allowlist ?? []).join('\n') });
  }

  async function saveAccess(patch: { inviteOnly?: boolean; allowlist?: string }) {
    setBusy(true);
    const res = await fetch('/api/admin/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      // Echo back what was actually STORED, not what was typed: entries that
      // are neither an address nor an "@domain" are dropped server-side, and
      // leaving them on screen would look like they were saved.
      setAccess({ inviteOnly: Boolean(b.inviteOnly), allowlist: (b.allowlist ?? []).join('\n') });
      setNotice(
        patch.inviteOnly === undefined
          ? 'Access list saved.'
          : patch.inviteOnly
            ? 'Sign-up is now invite-only.'
            : 'Sign-up is now open to everyone.',
      );
    } else {
      setNotice(b.error || 'Could not save access settings.');
    }
  }

  async function loadTax() {
    const r = await fetch('/api/admin/tax').then((x) => x.json()).catch(() => null);
    if (!r?.tax) return;
    setTax({
      enabled: Boolean(r.tax.enabled),
      gstin: r.tax.gstin ?? '',
      rate: String(r.tax.rate ?? 18),
      legalName: r.tax.legalName ?? '',
      address: r.tax.address ?? '',
    });
    setRevenue(r.revenue ?? null);
  }

  async function saveTax() {
    setBusy(true);
    const res = await fetch('/api/admin/tax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tax),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setNotice(res.ok ? 'GST settings saved.' : b.error || 'Could not save GST settings.');
    if (res.ok) await loadTax();
  }

  useEffect(() => {
    // Mount: the default window, matching `period`'s initial value.
    load('month');
    loadPromos();
    loadTax();
    loadAccess();
    setOrigin(window.location.origin);
  }, []);

  // Only the period needs the server — it changes what is counted.
  async function changePeriod(p: OrgPeriod) {
    setPeriod(p);
    setBusy(true);
    await load(p);
    setBusy(false);
  }

  // The same filters the export applies, so the button always hands over what
  // is currently on screen.
  const orgFilterParams = () =>
    new URLSearchParams({ period, plan: fPlan, status: fStatus, numbers: fNumbers, agents: fAgents }).toString();

  async function saveGemini() {
    if (!geminiKey.trim()) return;
    setBusy(true);
    const res = await fetch('/api/admin/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiApiKey: geminiKey.trim() }),
    });
    setBusy(false);
    setNotice(res.ok ? 'Gemini key updated — new calls use it within ~1 min.' : 'Could not save key.');
    if (res.ok) {
      setGeminiKey('');
      await load(period);
    }
  }

  async function clearGemini() {
    if (
      !(await confirm({
        title: 'Clear the platform Gemini key?',
        message: 'Calls will fall back to the server env key.',
        confirmLabel: 'Clear key',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    await fetch('/api/admin/secrets', { method: 'DELETE' });
    setBusy(false);
    await load(period);
  }

  async function savePricing() {
    setBusy(true);
    const overrides: Record<string, any> = {};
    for (const [k, e] of Object.entries(planEdits)) {
      const o: any = {};
      if (e.priceMonthly !== '' && Number.isFinite(Number(e.priceMonthly))) o.priceMonthly = Number(e.priceMonthly);
      if (e.pricePerMinute !== '' && Number.isFinite(Number(e.pricePerMinute))) o.pricePerMinute = Number(e.pricePerMinute);
      if (e.overagePerMinute !== '' && Number.isFinite(Number(e.overagePerMinute))) o.overagePerMinute = Number(e.overagePerMinute);
      const limits: any = {};
      for (const lf of LIMIT_FIELDS) {
        const v = e[lf.key];
        if (v !== '' && v != null && Number.isFinite(Number(v))) limits[lf.key] = Number(v);
      }
      if (Object.keys(limits).length) o.limits = limits;
      if (Object.keys(o).length) overrides[k] = o;
    }
    await fetch('/api/admin/pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
    });
    setBusy(false);
    setNotice('Pricing updated. (Empty limit = unlimited.)');
    await load(period);
  }

  function setPlanField(plan: string, field: string, val: string) {
    setPlanEdits((pe) => ({ ...pe, [plan]: { ...pe[plan], [field]: val } }));
  }

  async function loadPromos() {
    const r = await fetch('/api/admin/promo').then((x) => x.json()).catch(() => ({}));
    setPromos(r.codes ?? []);
  }

  async function createPromo() {
    setBusy(true);
    const res = await fetch('/api/admin/promo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promoForm),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setNotice(res.ok ? `Promo code ${b.promo?.code} created.` : b.error || 'Could not create the code.');
    if (res.ok) {
      setPromoForm({ code: '', description: '', percentOff: '', fixedPriceInr: '', plans: '', maxRedemptions: '', expiresInDays: '' });
      await loadPromos();
    }
  }

  async function togglePromo(code: string, active: boolean) {
    setBusy(true);
    await fetch('/api/admin/promo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, active }),
    });
    setBusy(false);
    await loadPromos();
  }

  async function saveCashfree() {
    setBusy(true);
    const payload: Record<string, string | boolean> = {
      appId: cashfree.appId,
      environment: cashfree.environment,
      subscriptionsEnabled: cashfree.subscriptionsEnabled,
      internationalEnabled: cashfree.internationalEnabled,
    };
    if (cashfree.secretKey.trim()) payload.secretKey = cashfree.secretKey.trim();
    await fetch('/api/admin/cashfree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    setNotice('Cashfree settings saved.');
    setCashfree((s) => ({ ...s, secretKey: '' }));
    await load(period);
  }

  async function saveMeta() {
    setBusy(true);
    const payload: Record<string, string> = {
      appId: meta.appId,
      configId: meta.configId,
      graphVersion: meta.graphVersion,
      chatAddonPriceInr: meta.chatAddonPriceInr || '0',
      wabaId: meta.wabaId,
      defaultPhoneNumberId: meta.defaultPhoneNumberId,
    };
    if (meta.appSecret.trim()) payload.appSecret = meta.appSecret.trim();
    if (meta.verifyToken.trim()) payload.verifyToken = meta.verifyToken.trim();
    if (meta.systemUserToken.trim()) payload.systemUserToken = meta.systemUserToken.trim();
    await fetch('/api/admin/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    setNotice('WhatsApp (Meta) settings saved.');
    setMeta((s) => ({ ...s, appSecret: '', verifyToken: '', systemUserToken: '' }));
    await load(period);
  }

  // Templates in the PLATFORM's own WABA. Worth surfacing here because a
  // template that was never created is invisible until it fails at send time —
  // which is how the shared sender spent weeks logging "template does not
  // exist" on every booking and quietly dropping each one to SMS.
  async function loadWaTemplates() {
    setBusy(true);
    const r = await fetch('/api/admin/whatsapp/templates').then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (!r || r.error) return setWaTmplNote(r?.error ?? 'Could not read template status.');
    setWaTemplates(r.templates ?? []);
    setWaTmplNote(r.configured ? null : 'No platform WABA configured yet.');
  }

  async function provisionWaTemplates() {
    setBusy(true);
    const r = await fetch('/api/admin/whatsapp/templates', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (!r || r.error) return setWaTmplNote(r?.error ?? 'Provisioning failed.');
    const failed = (r.failed ?? []) as Array<{ name: string; reason: string }>;
    setWaTmplNote(
      failed.length
        ? `Created ${r.created}. Failed: ${failed.map((f) => `${f.name} (${f.reason})`).join('; ')}`
        : `Created or already present: ${r.created}. Meta reviews each one before it can send.`,
    );
    await loadWaTemplates();
  }

  // Bill last month's overage minutes across all orgs (idempotent).
  async function runOverageSweep() {
    if (
      !(await confirm({
        title: 'Run the overage sweep?',
        message: 'Charges every org’s last-month overage minutes to its Cashfree mandate (scheduled 3 days out, so Cashfree can send the RBI pre-debit notice). Orgs without a mandate — which is all of them until Subscriptions is activated — are marked for manual invoicing. Safe to re-run.',
        confirmLabel: 'Run sweep',
      }))
    )
      return;
    setBusy(true);
    const res = await fetch('/api/admin/overage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setNotice(b.error || 'Overage sweep failed.');
      return;
    }
    const lines = (b.results ?? []).map((r: any) => `${r.org}: ${r.minutes} min → ₹${r.amountInr} (${r.status})`);
    setNotice(lines.length ? `Overage sweep ${b.month}: ${lines.join(' · ')}` : `Overage sweep ${b.month}: no overage found.`);
  }

  async function saveConfig() {
    setBusy(true);
    await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        liveModel: cfg.liveModel,
        liveVoice: cfg.liveVoice,
        liveSilenceMs: cfg.liveSilenceMs,
        liveTemperature: cfg.liveTemperature,
        geminiModel: cfg.geminiModel,
        systemPromptBase: cfg.systemPromptBase,
        callGuidance: cfg.callGuidance,
        typingSound: cfg.typingSound ? 'on' : 'off',
      }),
    });
    setBusy(false);
    setNotice('Runtime config saved — new calls pick it up within ~1 min.');
    await load(period);
  }

  async function setOrgStatus(org: Org, status: 'ACTIVE' | 'PAUSED' | 'DEACTIVATED') {
    let reason: string | null = null;
    if (status !== 'ACTIVE') {
      const paused = status === 'PAUSED';
      const ok = await confirm({
        title: `${paused ? 'Pause' : 'Deactivate'} ${org.name}?`,
        message: paused
          ? 'Their agents stop answering and no outbound calls are placed. Staff can still sign in, so they can settle an invoice. Nothing is deleted and this is reversible.'
          : 'Their agents stop answering AND staff cannot sign in. Nothing is deleted and this is reversible.',
        confirmLabel: paused ? 'Pause' : 'Deactivate',
        danger: true,
        note: {
          // This is shown to the org on their own screen, so it is worth wording
          // for them rather than for us.
          label: 'Reason to show them (optional)',
          placeholder: 'e.g. Invoice overdue — contact billing to restore service',
          defaultValue: org.statusReason ?? '',
          onConfirm: (v) => {
            reason = v || null;
          },
        },
      });
      if (!ok) return;
    }

    setBusy(true);
    const res = await fetch(`/api/admin/organizations/${org.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setNotice(res.ok ? `${org.name} is now ${status.toLowerCase()}.` : b.error || 'Could not change the status.');
    await load(period);
  }

  async function deleteOrg(org: Org) {
    // What deletion would actually remove, fetched first — these are the figures
    // the operator confirms against, exactly as the CLI does it.
    setBusy(true);
    const report = await fetch(`/api/admin/organizations/${org.id}`).then((r) => r.json()).catch(() => null);
    setBusy(false);
    if (!report || report.error) return setNotice(report?.error ?? 'Could not read the organisation.');

    const c = report.counts ?? {};
    const summary = [
      `${c.calls ?? 0} calls`,
      `${c.contacts ?? 0} patients`,
      `${c.visitRecords ?? 0} visit records`,
      `${c.appointments ?? 0} appointments`,
      `${c.workspaces ?? 0} workspaces`,
    ].join(', ');

    const ok = await confirm({
      title: `Permanently delete ${org.name}?`,
      message: `This erases ${summary} and cannot be undone. There is no backup restore short of the nightly dump. Consider deactivating instead.`,
      confirmLabel: 'Delete forever',
      danger: true,
      requireText: org.name,
      requireTextLabel: 'Type the organisation name exactly to confirm',
    });
    if (!ok) return;

    setBusy(true);
    const res = await fetch(`/api/admin/organizations/${org.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: org.name }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setNotice(res.ok ? `${org.name} deleted.` : b.error || 'Could not delete the organisation.');
    await load(period);
  }

  async function changeOrgPlan(id: string, plan: string) {
    setBusy(true);
    const res = await fetch(`/api/admin/orgs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    // Without this the dropdown just snapped back to the old value on failure,
    // which reads as "it errored" with nothing explaining why.
    setNotice(res.ok ? `Plan changed to ${plan}.` : b.error || 'Could not change the plan.');
    await load(period);
  }

  if (!data) return <Spinner />;

  // Filtered in the browser, using the SAME predicate the export route applies
  // server-side — one rule, so the CSV can never contain a different set of
  // organisations than the table it was exported from.
  const visibleOrgs = data.orgs.filter((o) =>
    matchesOrgFilters(o, { plan: fPlan, status: fStatus, numbers: fNumbers, agents: fAgents }),
  );
  const s = data.stats;

  return (
    <div className="space-y-6">
      <PageHeader title="Platform admin" subtitle="Founder-only controls — keys, pricing, and tenants." />

      {notice && (
        <div className="rounded-xl border border-primary/40 px-4 py-2.5 text-sm text-ink">{notice}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Organizations" value={s.orgs} />
        <Stat label="Users" value={s.users} />
        <Stat label="Workspaces" value={s.workspaces} />
        <Stat label="Agents" value={s.agents} />
        <Stat label="Calls (mo)" value={s.callsThisMonth} />
        <Stat label="Minutes (mo)" value={s.minutesThisMonth} />
      </div>

      {/* Who can get in at all */}
      {access && (
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-ink">Sign-up access</h3>
            <Badge tone={access.inviteOnly ? 'warning' : 'success'}>
              {access.inviteOnly ? 'invite only' : 'open to everyone'}
            </Badge>
          </div>
          <p className="text-xs text-muted">
            While this is on, only the addresses below — plus anyone already in an organisation, anyone holding a
            live team invitation, and you — can sign in or create an account. Everyone else is sent to the contact
            page. One address or <span className="text-ink-soft">@domain.com</span> per line.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={access.inviteOnly ? 'primary' : 'secondary'}
              onClick={() => saveAccess({ inviteOnly: !access.inviteOnly })}
              disabled={busy}
            >
              {access.inviteOnly ? 'Open sign-up to everyone' : 'Make sign-up invite-only'}
            </Button>
          </div>
          <Field label="Allowed addresses">
            <Textarea
              rows={4}
              value={access.allowlist}
              onChange={(e) => setAccess((a) => (a ? { ...a, allowlist: e.target.value } : a))}
              placeholder={'dr.rao@smilecare.in\n@apollohospitals.com'}
            />
          </Field>
          <Button size="sm" onClick={() => saveAccess({ allowlist: access.allowlist })} disabled={busy}>
            Save access list
          </Button>
        </Card>
      )}

      {/* Platform Gemini key */}
      <TeamCallCalendarCard />

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Platform Gemini API key</h3>
          {data.secrets.geminiSet ? (
            <Badge tone="success">set · {data.secrets.geminiHint}</Badge>
          ) : (
            <Badge tone="neutral">using server env key</Badge>
          )}
        </div>
        <p className="text-xs text-muted">
          Used by all calls + LLM features, preferred over the server env key. Rotate it here when a key runs out of
          quota — no redeploy needed (new calls pick it up within ~1 minute).
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[240px]">
            <Field label="New key">
              <Input
                type="password"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AQ.… or AIza…"
              />
            </Field>
          </div>
          <Button onClick={saveGemini} disabled={busy || !geminiKey.trim()}>
            Save key
          </Button>
          {data.secrets.geminiSet && (
            <Button variant="ghost" onClick={clearGemini} disabled={busy}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      {/* System config — runtime tunables (were .env) */}
      <Card className="space-y-3">
        <h3 className="text-sm font-medium text-ink">System config</h3>
        <p className="text-xs text-muted">
          Runtime knobs for the voice pipeline. Blank = use the server default. New calls pick up changes within ~1 minute
          (no redeploy).
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Gemini Live model">
            <Input value={cfg.liveModel} onChange={(e) => setCfg((c) => ({ ...c, liveModel: e.target.value }))} placeholder="gemini-2.5-flash-native-audio-latest" />
          </Field>
          <Field label="Default Live voice">
            <Input value={cfg.liveVoice} onChange={(e) => setCfg((c) => ({ ...c, liveVoice: e.target.value }))} placeholder="Aoede" />
          </Field>
          <Field label="Silence ms (turn-end)">
            <Input type="number" min={100} value={cfg.liveSilenceMs} onChange={(e) => setCfg((c) => ({ ...c, liveSilenceMs: e.target.value }))} placeholder="450" />
          </Field>
          <Field label="Temperature (0–2)" hint="Higher = more varied; lower = more focused.">
            <Input type="number" min={0} max={2} step={0.1} value={cfg.liveTemperature} onChange={(e) => setCfg((c) => ({ ...c, liveTemperature: e.target.value }))} placeholder="0.8" />
          </Field>
          <Field label="Gemini text model">
            <Input value={cfg.geminiModel} onChange={(e) => setCfg((c) => ({ ...c, geminiModel: e.target.value }))} placeholder="gemini-2.5-flash" />
          </Field>
          <Field label="Typing sound" hint="Subtle keyboard ambience while the agent &ldquo;thinks&rdquo; between turns.">
            <label className="flex items-center gap-2 pt-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={cfg.typingSound}
                onChange={(e) => setCfg((c) => ({ ...c, typingSound: e.target.checked }))}
                className="h-4 w-4 accent-primary"
              />
              Play typing sound between turns
            </label>
          </Field>
        </div>
        <Field label="Base system prompt (prepended to every agent's prompt)">
          <Textarea
            rows={6}
            value={cfg.systemPromptBase}
            onChange={(e) => setCfg((c) => ({ ...c, systemPromptBase: e.target.value }))}
            placeholder={data.config?.systemPromptDefault || 'Leave blank for no global prefix.'}
          />
        </Field>
        <Field label="Spoken-call guidance (appended to every agent's prompt)" hint="The phone-call persona wording added just before the greeting instruction.">
          <Textarea
            rows={2}
            value={cfg.callGuidance}
            onChange={(e) => setCfg((c) => ({ ...c, callGuidance: e.target.value }))}
            placeholder={data.config?.callGuidanceDefault || 'This is a live phone call. Speak in short, natural, spoken sentences.'}
          />
        </Field>
        <Button size="sm" onClick={saveConfig} disabled={busy}>
          Save system config
        </Button>
      </Card>

      {/* Prompt assembly explainer — exactly what gets sent to Gemini Live */}
      <Card className="space-y-3">
        <h3 className="text-sm font-medium text-ink">What gets sent to Gemini Live</h3>
        <p className="text-xs text-muted">
          On every call the <code className="text-ink-soft">systemInstruction</code> is assembled top-to-bottom from these
          pieces. The <span className="text-accent">accent</span> pieces are editable above (platform-wide); the rest come
          from the agent.
        </p>
        <ol className="space-y-1.5 rounded-lg border border-border bg-surface-2 p-3 text-xs">
          <li><span className="text-accent">① Base system prompt</span> <span className="text-muted">— platform-wide prefix</span></li>
          <li><span className="text-ink">② Agent system prompt</span> <span className="text-muted">— per agent (with variables filled in)</span></li>
          <li><span className="text-ink">③ Knowledge base</span> <span className="text-muted">— top chunks retrieved for the agent</span></li>
          <li><span className="text-ink">④ Language style</span> <span className="text-muted">— hybrid / code-switch instruction</span></li>
          <li><span className="text-ink">⑤ Fallback line</span> <span className="text-muted">— what to say when unsure</span></li>
          <li><span className="text-ink">⑥ End-call rule</span> <span className="text-muted">— when to hang up (if configured)</span></li>
          <li><span className="text-accent">⑦ Spoken-call guidance</span> <span className="text-muted">+ greeting example</span></li>
        </ol>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={loadPreview} disabled={previewing}>
            {previewing ? <Spinner /> : preview ? 'Refresh exact prompt' : 'Show exact prompt & parameters'}
          </Button>
          <span className="text-[11px] text-muted">Rendered for a representative agent, using your saved settings.</span>
        </div>
        {preview && (
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-xs font-medium text-ink">systemInstruction (exact text)</div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-ink">
{preview.systemText}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-ink">config (parameters sent to live.connect)</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-ink">
{JSON.stringify(preview.params, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Card>

      {/* Pricing & plan limits */}
      <Card className="space-y-3">
        <h3 className="text-sm font-medium text-ink">Plans — pricing &amp; limits</h3>
        <p className="text-xs text-muted">
          Edit any value. Leave a limit blank for unlimited, or set it to 0 to exclude that product from the plan.
          Enterprise is “talk to us” on the public page regardless of price. Saving replaces every override at once, so
          every plan stays on this page — don’t hide any of them behind a filter.
        </p>
        <div className="grid gap-3 lg:grid-cols-3">
          {data.plans.map((p) => {
            const e = planEdits[p.key] ?? ({ priceMonthly: '' } as PlanEdit);
            return (
              <div key={p.key} className={`rounded-lg border border-border p-3 ${p.legacy ? 'opacity-70' : ''}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{p.name}</span>
                  {p.product && !p.legacy && !p.contactSales && <Badge tone="neutral">{p.product}</Badge>}
                  {p.legacy && <Badge tone="warning">retired</Badge>}
                  {p.contactSales && <Badge tone="accent">contact sales</Badge>}
                </div>
                <label className="label">Price / month (₹)</label>
                <Input type="number" min={0} value={e.priceMonthly ?? ''} onChange={(ev) => setPlanField(p.key, 'priceMonthly', ev.target.value)} />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <label className="label !mb-0.5 text-[10px]">₹ / min (headline)</label>
                    <Input type="number" min={0} step="0.1" placeholder="—" value={e.pricePerMinute ?? ''} onChange={(ev) => setPlanField(p.key, 'pricePerMinute', ev.target.value)} />
                  </div>
                  <div>
                    <label className="label !mb-0.5 text-[10px]">₹ / min overage</label>
                    <Input type="number" min={0} step="0.1" placeholder="—" value={e.overagePerMinute ?? ''} onChange={(ev) => setPlanField(p.key, 'overagePerMinute', ev.target.value)} />
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {LIMIT_FIELDS.map((lf) => (
                    <div key={lf.key}>
                      <label className="label !mb-0.5 text-[10px]">{lf.label}</label>
                      <Input
                        type="number"
                        min={0}
                        placeholder="∞"
                        value={e[lf.key] ?? ''}
                        onChange={(ev) => setPlanField(p.key, lf.key, ev.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <Button size="sm" onClick={savePricing} disabled={busy}>
          Save plans
        </Button>
      </Card>

      {/* Cashfree payments (current gateway) */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Cashfree payments</h3>
          <div className="flex items-center gap-2">
            {data.cashfree.configured && (
              <Badge tone={data.cashfree.live ? 'success' : 'neutral'}>{data.cashfree.live ? 'live' : 'sandbox'}</Badge>
            )}
            <Badge tone={data.cashfree.mode === 'subscription' ? 'success' : 'warning'}>
              {data.cashfree.mode === 'subscription' ? 'auto-debit' : 'one-time only'}
            </Badge>
            <Badge tone={data.cashfree.configured ? 'success' : 'neutral'}>
              {data.cashfree.configured ? 'configured' : 'not configured'}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted">
          Paste your Cashfree <span className="text-ink-soft">App ID + Secret Key</span> (Dashboard → Developers →
          API Keys). There are no plan IDs to create — the amount and monthly cycle travel with each subscription, so
          plan prices come straight from the catalogue above.
        </p>
        <p className="text-xs text-muted">
          Set the webhook to <code className="text-ink-soft">{origin}/api/billing/cashfree/webhook</code> under
          Developers → Webhooks, subscribed to the payment and subscription events. It is signed with the same secret
          key, so there is nothing extra to configure here.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="App ID">
            <Input value={cashfree.appId} onChange={(e) => setCashfree((s) => ({ ...s, appId: e.target.value }))} placeholder="e.g. 1027master7d9c8f1f7201" />
          </Field>
          <Field label={`Secret key${data.cashfree.secretSet ? ' (set — leave blank to keep)' : ''}`}>
            <Input type="password" value={cashfree.secretKey} onChange={(e) => setCashfree((s) => ({ ...s, secretKey: e.target.value }))} placeholder="cfsk_ma_prod_…" />
          </Field>
          <Field label="Environment">
            <Select value={cashfree.environment} onChange={(e) => setCashfree((s) => ({ ...s, environment: e.target.value }))}>
              <option value="sandbox">Sandbox (sandbox.cashfree.com)</option>
              <option value="production">Production (api.cashfree.com)</option>
            </Select>
          </Field>
        </div>

        {/* The one switch that changes how billing works. Off = Payment Gateway
            only, which is all the account has until Subscriptions is approved. */}
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={cashfree.subscriptionsEnabled}
            onChange={(e) => setCashfree((s) => ({ ...s, subscriptionsEnabled: e.target.checked }))}
          />
          <span className="text-xs text-muted">
            <span className="font-medium text-ink">Subscriptions product is activated</span>
            <br />
            Turn this on only once <span className="text-ink-soft">Subscriptions</span> appears under your active
            products in the Cashfree dashboard. Off, customers pay one month at a time and renew manually — the
            Payment Gateway cannot create mandates. On, checkout registers a UPI Autopay / eNACH / card mandate that
            Cashfree auto-debits monthly, and overage can be charged to it.
          </span>
        </label>

        {/* Off, checkout shows customers outside India a "coming soon" gate
            instead of a hosted page that is certain to decline their card. */}
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={cashfree.internationalEnabled}
            onChange={(e) => setCashfree((s) => ({ ...s, internationalEnabled: e.target.checked }))}
          />
          <span className="text-xs text-muted">
            <span className="font-medium text-ink">International cards are activated</span>
            <br />
            Turn this on only once <span className="text-ink-soft">International Cards</span> show as active under
            Payment Gateway → Payment Methods. Off, customers outside India can fill in their billing details but
            are asked to email us instead of being sent to a checkout that would decline them. Note Cashfree bars
            <span className="text-ink-soft"> individual</span> merchants from international cards altogether — the
            account has to be a registered company or LLP first.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={saveCashfree} disabled={busy}>
            Save Cashfree settings
          </Button>
          <Button size="sm" variant="secondary" onClick={runOverageSweep} disabled={busy}>
            Run last month’s overage sweep
          </Button>
        </div>
      </Card>

      {/* GST / tax */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">GST &amp; invoicing</h3>
          <Badge tone={tax.enabled ? 'success' : 'warning'}>
            {tax.enabled ? `charging ${tax.rate}%` : 'not charging GST'}
          </Badge>
        </div>
        <p className="text-xs text-muted">
          Prices are <span className="text-ink-soft">tax-exclusive</span>: GST is added on top of the catalogue
          price, so your revenue per plan is unchanged and registered customers reclaim it as input credit. The
          split is worked out per customer — CGST+SGST within your own state, IGST outside it.
        </p>
        <p className="text-xs text-muted">
          Leave this <span className="text-ink-soft">off</span> until your GSTIN is issued. Charging GST without a
          registration is an offence, so the toggle refuses to turn on without one.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="GSTIN">
            <Input
              className="font-mono uppercase"
              value={tax.gstin}
              onChange={(e) => setTax((s) => ({ ...s, gstin: e.target.value.toUpperCase() }))}
              placeholder="37ABCDE1234F1Z5"
            />
          </Field>
          <Field label="Rate (%)">
            <Input value={tax.rate} onChange={(e) => setTax((s) => ({ ...s, rate: e.target.value }))} placeholder="18" inputMode="numeric" />
          </Field>
          <Field label="Registered legal name">
            <Input value={tax.legalName} onChange={(e) => setTax((s) => ({ ...s, legalName: e.target.value }))} placeholder="As on the GST certificate" />
          </Field>
          <Field label="Registered address">
            <Input value={tax.address} onChange={(e) => setTax((s) => ({ ...s, address: e.target.value }))} placeholder="Street, city, state, PIN" />
          </Field>
        </div>
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={tax.enabled}
            onChange={(e) => setTax((s) => ({ ...s, enabled: e.target.checked }))}
          />
          <span className="text-xs text-muted">
            <span className="font-medium text-ink">Charge GST on all new payments</span>
            <br />
            Turn on only once your registration is live. Existing invoices are never altered — they keep whatever
            was charged at the time.
          </span>
        </label>
        <Button size="sm" onClick={saveTax} disabled={busy}>
          Save GST settings
        </Button>

        {revenue && revenue.invoices > 0 && (
          <div className="rounded-xl border border-border bg-surface-2 p-4">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted">
              Collected across {revenue.invoices} invoice{revenue.invoices === 1 ? '' : 's'}
            </h4>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Gross collected</dt>
                <dd className="text-ink">₹{revenue.collectedInr.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">GST (owed to govt)</dt>
                <dd className="text-ink">₹{revenue.taxCollectedInr.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Cashfree fee (est.)</dt>
                <dd className="text-ink">−₹{revenue.estGatewayFeeInr.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex justify-between gap-4 font-semibold">
                <dt className="text-ink">Net to you (est.)</dt>
                <dd className="text-ink">₹{revenue.estNetInr.toLocaleString('en-IN')}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[11px] text-muted">
              Gateway fee estimated at 2% + 18% GST on the fee; the real rate varies by payment method — settlement
              reports in the Cashfree dashboard are authoritative.
            </p>
          </div>
        )}
      </Card>

      {/* Promo codes */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Promo codes</h3>
          <Badge tone={promos.some((p) => p.active) ? 'success' : 'neutral'}>
            {promos.filter((p) => p.active).length} active
          </Badge>
        </div>
        <p className="text-xs text-muted">
          Discounts applied at checkout. Set <span className="text-ink-soft">either</span> a percentage off{' '}
          <span className="text-ink-soft">or</span> a fixed price (a fixed price replaces the plan price outright —
          use it for a cheap live test transaction). Codes apply to one-time payments only: an auto-renewing
          mandate would carry the discount for every future month.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code">
            <Input value={promoForm.code} onChange={(e) => setPromoForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} placeholder="LAUNCH50" />
          </Field>
          <Field label="Percent off">
            <Input value={promoForm.percentOff} onChange={(e) => setPromoForm((s) => ({ ...s, percentOff: e.target.value }))} placeholder="e.g. 50" inputMode="numeric" />
          </Field>
          <Field label="…or fixed price ₹">
            <Input value={promoForm.fixedPriceInr} onChange={(e) => setPromoForm((s) => ({ ...s, fixedPriceInr: e.target.value }))} placeholder="e.g. 10" inputMode="numeric" />
          </Field>
          <Field label="Limit to plans (blank = all)">
            <Input value={promoForm.plans} onChange={(e) => setPromoForm((s) => ({ ...s, plans: e.target.value }))} placeholder="starter,growth" />
          </Field>
          <Field label="Max redemptions (blank = ∞)">
            <Input value={promoForm.maxRedemptions} onChange={(e) => setPromoForm((s) => ({ ...s, maxRedemptions: e.target.value }))} placeholder="e.g. 1" inputMode="numeric" />
          </Field>
          <Field label="Expires in days (blank = never)">
            <Input value={promoForm.expiresInDays} onChange={(e) => setPromoForm((s) => ({ ...s, expiresInDays: e.target.value }))} placeholder="e.g. 30" inputMode="numeric" />
          </Field>
        </div>
        <Button size="sm" onClick={createPromo} disabled={busy || !promoForm.code.trim()}>
          Create promo code
        </Button>

        {promos.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Discount</th>
                  <th className="py-2 pr-4">Plans</th>
                  <th className="py-2 pr-4">Used</th>
                  <th className="py-2 pr-4">Expires</th>
                  <th className="py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {promos.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono text-ink">{p.code}</td>
                    <td className="py-2 pr-4 text-ink-soft">
                      {p.fixedPriceInr != null ? `₹${p.fixedPriceInr} flat` : `${p.percentOff}% off`}
                    </td>
                    <td className="py-2 pr-4 text-muted">{p.plans || 'all'}</td>
                    <td className="py-2 pr-4 text-muted">
                      {p.timesRedeemed}
                      {p.maxRedemptions != null ? ` / ${p.maxRedemptions}` : ''}
                    </td>
                    <td className="py-2 pr-4 text-muted">
                      {p.expiresAt ? new Date(p.expiresAt).toLocaleDateString('en-IN') : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      <Button size="sm" variant="secondary" onClick={() => togglePromo(p.code, !p.active)} disabled={busy}>
                        {p.active ? 'Disable' : 'Enable'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* WhatsApp (Meta Cloud API / Embedded Signup) — hidden while the
          platform-wide WHATSAPP_ENABLED flag is off */}
      {data.whatsapp.featureEnabled && (
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">WhatsApp (Meta Cloud API)</h3>
          <Badge tone={data.whatsapp.configured ? 'success' : 'neutral'}>
            {data.whatsapp.configured ? 'configured' : 'not configured'}
          </Badge>
        </div>
        <p className="text-xs text-muted">
          Your Meta <span className="text-ink-soft">Tech Provider</span> app, so customers connect their own WhatsApp
          number via Embedded Signup. Needs Business Verification + App Review for{' '}
          <code className="text-ink-soft">whatsapp_business_management/_messaging</code>. Webhook URL:{' '}
          <code className="text-ink-soft">/api/whatsapp/webhook</code> (use the verify token below).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="App ID">
            <Input value={meta.appId} onChange={(e) => setMeta((s) => ({ ...s, appId: e.target.value }))} placeholder="1234567890" />
          </Field>
          <Field label={`App secret${data.whatsapp.secretSet ? ' (set — leave blank to keep)' : ''}`}>
            <Input type="password" value={meta.appSecret} onChange={(e) => setMeta((s) => ({ ...s, appSecret: e.target.value }))} placeholder="app secret" />
          </Field>
          <Field label="Embedded Signup config ID">
            <Input value={meta.configId} onChange={(e) => setMeta((s) => ({ ...s, configId: e.target.value }))} placeholder="config id" />
          </Field>
          <Field label={`Webhook verify token${data.whatsapp.verifySet ? ' (set — leave blank to keep)' : ''}`}>
            <Input type="password" value={meta.verifyToken} onChange={(e) => setMeta((s) => ({ ...s, verifyToken: e.target.value }))} placeholder="any random string" />
          </Field>
          <Field label="Graph API version">
            <Input value={meta.graphVersion} onChange={(e) => setMeta((s) => ({ ...s, graphVersion: e.target.value }))} placeholder="v21.0" />
          </Field>
          <Field label="Follow-up chat add-on price (₹ / mo)">
            <Input
              type="number"
              min={0}
              value={meta.chatAddonPriceInr}
              onChange={(e) => setMeta((s) => ({ ...s, chatAddonPriceInr: e.target.value }))}
              placeholder="0 = off / not offered"
            />
          </Field>
          <Field label="WABA ID (for platform-pool numbers)">
            <Input value={meta.wabaId} onChange={(e) => setMeta((s) => ({ ...s, wabaId: e.target.value }))} placeholder="your WhatsApp Business Account id" />
          </Field>
          <Field label={`System-user token${data.whatsapp.systemTokenSet ? ' (set — leave blank to keep)' : ''}`}>
            <Input type="password" value={meta.systemUserToken} onChange={(e) => setMeta((s) => ({ ...s, systemUserToken: e.target.value }))} placeholder="long-lived system-user token" />
          </Field>
          <Field label="Shared sender phone number ID (one number for all businesses)">
            <Input value={meta.defaultPhoneNumberId} onChange={(e) => setMeta((s) => ({ ...s, defaultPhoneNumberId: e.target.value }))} placeholder="phone number id of the shared sender" />
          </Field>
        </div>
        <p className="text-xs text-muted">
          The add-on lets callers text follow-up questions on WhatsApp, answered from the agent’s knowledge base. Set a
          monthly price above 0 to make it available for owners to enable (billed via the monthly sweep).
        </p>
        <Button size="sm" onClick={saveMeta} disabled={busy}>
          Save WhatsApp settings
        </Button>

        {/* Message templates in our own WABA */}
        <div className="mt-5 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Shared-sender message templates
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={loadWaTemplates} disabled={busy}>
                Check status
              </Button>
              <Button size="sm" onClick={provisionWaTemplates} disabled={busy}>
                Create missing
              </Button>
            </div>
          </div>
          <p className="mt-1 text-xs text-muted">
            Proactive messages (confirmations, reminders, reschedules, cancellations, sign-in codes) must be
            pre-approved templates — Meta rejects free text. WhatsApp is the only channel, so anything below that is
            not <span className="text-ink-soft">APPROVED</span> is simply not delivered.
          </p>
          {waTemplates && (
            <div className="mt-3 space-y-1.5">
              {waTemplates.map((t) => (
                <div
                  key={t.name}
                  className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-1.5"
                >
                  <code className="text-[11px] text-ink-soft">{t.name}</code>
                  <Badge tone={t.status === 'APPROVED' ? 'success' : t.status === 'MISSING' ? 'danger' : 'warning'}>
                    {t.status.toLowerCase()}
                  </Badge>
                </div>
              ))}
            </div>
          )}
          {waTmplNote && <p className="mt-2 text-xs text-ink-soft">{waTmplNote}</p>}
        </div>
      </Card>
      )}

      {/* Organizations */}
      <Card className="p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3 text-sm font-medium text-ink">
          <span>
            Organizations ({visibleOrgs.length}
            {visibleOrgs.length !== data.orgs.length && <span className="text-muted"> of {data.orgs.length}</span>})
          </span>
          {/* Acceptance coverage at a glance. This is the number to watch after
              the re-acceptance prompt ships: it should fall to zero as owners
              sign in. Orgs missing it are ones we cannot evidence agreed to the
              DPA — including that notifying patients is their job. */}
          {(() => {
            const missing = data.orgs.filter((o) => !o.termsAcceptedAt).length;
            return missing > 0 ? (
              <span className="text-xs font-normal text-warning">
                {missing} of {data.orgs.length} without recorded acceptance
              </span>
            ) : (
              <span className="text-xs font-normal text-muted">All acceptances recorded</span>
            );
          })()}
        </div>
        {/* Filters + export */}
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-3">
          <label className="text-[11px] text-muted">
            <span className="mb-1 block font-medium uppercase tracking-wide">Period</span>
            <Select value={period} onChange={(e) => changePeriod(e.target.value as OrgPeriod)} className="w-auto" disabled={busy}>
              {ORG_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-[11px] text-muted">
            <span className="mb-1 block font-medium uppercase tracking-wide">Plan</span>
            <Select value={fPlan} onChange={(e) => setFPlan(e.target.value)} className="w-auto">
              <option value="all">All plans</option>
              {data.plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-[11px] text-muted">
            <span className="mb-1 block font-medium uppercase tracking-wide">Status</span>
            <Select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="w-auto">
              <option value="all">Any status</option>
              <option value="ACTIVE">Active</option>
              <option value="PAUSED">Paused</option>
              <option value="DEACTIVATED">Deactivated</option>
            </Select>
          </label>
          <label className="text-[11px] text-muted">
            <span className="mb-1 block font-medium uppercase tracking-wide">Numbers</span>
            <Select value={fNumbers} onChange={(e) => setFNumbers(e.target.value as 'all' | 'with' | 'without')} className="w-auto">
              <option value="all">Any</option>
              <option value="with">Has a number</option>
              <option value="without">No number yet</option>
            </Select>
          </label>
          <label className="text-[11px] text-muted">
            <span className="mb-1 block font-medium uppercase tracking-wide">Agents</span>
            <Select value={fAgents} onChange={(e) => setFAgents(e.target.value as 'all' | 'with' | 'without')} className="w-auto">
              <option value="all">Any</option>
              <option value="with">Has an agent</option>
              <option value="without">No agent yet</option>
            </Select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            {(fPlan !== 'all' || fStatus !== 'all' || fNumbers !== 'all' || fAgents !== 'all') && (
              <button
                className="text-[11px] text-primary hover:underline"
                onClick={() => { setFPlan('all'); setFStatus('all'); setFNumbers('all'); setFAgents('all'); }}
              >
                Clear filters
              </button>
            )}
            {/* A plain link, so the browser downloads it rather than us building
                a blob — and the filters travel with it, so the file matches the
                table you are looking at. */}
            <a href={`/api/admin/organizations/export?${orgFilterParams()}`} download>
              <Button variant="secondary" size="sm">Export CSV</Button>
            </a>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Owner sign-in</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 font-medium" title="Usage over the selected period">
                  Minutes
                </th>
                <th className="px-5 py-2.5 font-medium">Agents</th>
                <th className="px-5 py-2.5 font-medium">Numbers</th>
                <th className="px-5 py-2.5 font-medium">Members</th>
                <th className="px-5 py-2.5 font-medium">Terms</th>
                <th className="px-5 py-2.5 font-medium">Plan</th>
                <th className="px-5 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrgs.map((o) => (
                <tr key={o.id} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-2.5 text-ink">
                    {o.name}
                    <div className="text-[11px] text-muted">{o._count.workspaces} workspace{o._count.workspaces === 1 ? '' : 's'}</div>
                  </td>
                  <td className="px-5 py-2.5">
                    {o.ownerEmail ? (
                      <a href={`mailto:${o.ownerEmail}`} className="text-ink-soft hover:text-primary hover:underline">
                        {o.ownerEmail}
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    <Badge tone={o.status === 'ACTIVE' ? 'success' : o.status === 'PAUSED' ? 'warning' : 'danger'}>
                      {o.status.toLowerCase()}
                    </Badge>
                    {o.statusReason && (
                      <div className="mt-0.5 max-w-[200px] truncate text-[11px] text-muted" title={o.statusReason}>
                        {o.statusReason}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-muted">
                    {o.minutes.toLocaleString()}
                    <div className="text-[11px] text-muted/70">{o.calls} call{o.calls === 1 ? '' : 's'}</div>
                  </td>
                  <td className="px-5 py-2.5 text-muted">{o.agents}</td>
                  <td className="px-5 py-2.5">
                    {o.phoneNumbers > 0 ? (
                      <span className="text-muted">{o.phoneNumbers}</span>
                    ) : (
                      <Badge tone="warning">none</Badge>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-muted">{o._count.memberships}</td>
                  <td className="px-5 py-2.5">
                    {o.termsAcceptedAt ? (
                      <span className="text-muted">
                        {new Date(o.termsAcceptedAt).toLocaleDateString('en-IN')}
                        <span className="ml-1.5 text-xs text-muted/70">{o.termsVersion}</span>
                      </span>
                    ) : (
                      <Badge tone="warning">Not recorded</Badge>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    <Select
                      value={o.plan}
                      onChange={(e) => changeOrgPlan(o.id, e.target.value)}
                      className="w-auto"
                    >
                      {data.plans.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-5 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {o.status === 'ACTIVE' ? (
                        <>
                          <Button variant="secondary" size="sm" onClick={() => setOrgStatus(o, 'PAUSED')}>
                            Pause
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setOrgStatus(o, 'DEACTIVATED')}>
                            Deactivate
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" onClick={() => setOrgStatus(o, 'ACTIVE')}>
                            Reactivate
                          </Button>
                          {o.status === 'PAUSED' && (
                            <Button variant="secondary" size="sm" onClick={() => setOrgStatus(o, 'DEACTIVATED')}>
                              Deactivate
                            </Button>
                          )}
                        </>
                      )}
                      <Button variant="danger" size="sm" onClick={() => deleteOrg(o)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toLocaleString() : '∞';
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="py-3">
      <div className="text-2xl font-semibold text-ink">{value.toLocaleString()}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </Card>
  );
}
