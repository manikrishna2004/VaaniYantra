'use client';

import { useEffect, useState, useCallback } from 'react';

type Key = {
  id: string;
  name: string;
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes: string[];
  // True for a key minted before scopes were enforced. It works everywhere
  // today and will stop the day strict mode is switched on, so it is shown as
  // a warning rather than as an empty list — an empty list reads like a choice.
  legacyUnscoped: boolean;
};

// Grouped for the picker so a flat list of resource:action strings does not
// become a wall of checkboxes. Only the actions the v1 API actually exposes
// are offered: granting `numbers:write` today would be granting nothing.
const SCOPE_GROUPS: { resource: string; label: string; actions: string[] }[] = [
  { resource: 'agents', label: 'Agents', actions: ['read'] },
  { resource: 'calls', label: 'Calls', actions: ['read', 'write'] },
  { resource: 'numbers', label: 'Phone numbers', actions: ['read'] },
  { resource: 'appointments', label: 'Appointments', actions: ['read'] },
  { resource: 'patients', label: 'Patients & visits', actions: ['read', 'write'] },
];

export function ApiKeysManager({ canManage, apiBase }: { canManage: boolean; apiBase: string }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [name, setName] = useState('');
  // Least privilege by default: nothing is ticked, so a key reaches only what
  // its creator deliberately granted.
  const [scopes, setScopes] = useState<string[]>([]);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const data = await fetch('/api/keys').then((r) => r.json());
    setKeys(data.keys ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (scopes.length === 0) {
      setError('Pick at least one permission for this key.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || 'Default key', scopes }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      setCreated({ name: data.name, key: data.key });
      setName('');
      setScopes([]);
      await load();
    } else {
      setError(data.error ?? 'Could not create the key.');
    }
  }

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function revoke(id: string) {
    await fetch(`/api/keys/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="space-y-6">
      {created && (
        <div className="rounded-2xl border border-success/30 bg-success/10 p-5">
          <h3 className="text-sm font-medium text-ink">Your new API key</h3>
          <p className="mt-1 text-xs text-success/80">
            Copy it now — for security it won&apos;t be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-ink">
              {created.key}
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(created.key);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setCreated(null)}
            className="mt-3 text-xs text-muted underline"
          >
            Done
          </button>
        </div>
      )}

      {canManage && (
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-sm font-medium text-ink">Create API key</h2>
          <form onSubmit={create} className="mt-3 space-y-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production server"
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary"
            />

            <fieldset>
              <legend className="text-xs font-medium text-ink">What may this key do?</legend>
              <p className="mt-1 text-[11px] text-muted">
                Grant only what the integration needs. Patient scopes reach medical records.
              </p>
              <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                {SCOPE_GROUPS.flatMap((g) =>
                  g.actions.map((action) => {
                    const scope = `${g.resource}:${action}`;
                    return (
                      <label
                        key={scope}
                        className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-ink"
                      >
                        <input
                          type="checkbox"
                          checked={scopes.includes(scope)}
                          onChange={() => toggleScope(scope)}
                          className="accent-primary"
                        />
                        <span className="flex-1">
                          {g.label}
                          <span className="text-muted"> · {action}</span>
                        </span>
                        {g.resource === 'patients' && (
                          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                            PHI
                          </span>
                        )}
                      </label>
                    );
                  }),
                )}
              </div>
            </fieldset>

            {error && <p className="text-xs text-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create key'}
            </button>
          </form>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">Keys</h2>
        {!keys && <div className="mt-3 text-sm text-muted">Loading…</div>}
        {keys && keys.length === 0 && (
          <div className="mt-3 text-sm text-muted">No API keys yet.</div>
        )}
        <ul className="mt-3 divide-y divide-border">
          {keys?.map((k) => (
            <li key={k.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">
                  {k.name}
                  {k.revokedAt && <span className="ml-2 text-[11px] text-danger">revoked</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">
                  {k.masked}
                  {k.lastUsedAt
                    ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : ' · never used'}
                </div>
                {!k.revokedAt && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {k.legacyUnscoped ? (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        Unrestricted — created before permissions existed. Replace it with a scoped key.
                      </span>
                    ) : (
                      k.scopes.map((s) => (
                        <code
                          key={s}
                          className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
                        >
                          {s === '*' ? 'all permissions' : s}
                        </code>
                      ))
                    )}
                  </div>
                )}
              </div>
              {canManage && !k.revokedAt && (
                <button
                  onClick={() => revoke(k.id)}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger/10"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">Using the API</h2>
        <p className="mt-1 text-xs text-muted">
          Authenticate every request with a Bearer token (or an <code className="text-ink">x-api-key</code> header).
          All endpoints are scoped to your organization.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-[11px] text-ink">
{`curl ${apiBase}/api/v1/calls \\
  -H "Authorization: Bearer ck_live_..."`}
        </pre>

        <h3 className="mt-4 text-xs font-medium text-ink">Endpoints</h3>
        <ul className="mt-2 space-y-1.5 text-[11px] text-muted">
          {[
            ['GET', '/api/v1/agents', 'List your agents'],
            ['GET', '/api/v1/agents/:id', 'Get one agent'],
            ['GET', '/api/v1/calls', 'List calls (filters: direction, status, agentId; limit, offset)'],
            ['GET', '/api/v1/calls/:id', 'Get a call with its full transcript'],
            ['POST', '/api/v1/calls', 'Place an outbound call — body: { agentId, to, fromNumberId? }'],
            ['GET', '/api/v1/numbers', 'List your phone numbers'],
            ['GET', '/api/v1/appointments', 'List appointments (filters: status, upcoming)'],
          ].map(([m, path, desc]) => (
            <li key={path} className="flex flex-wrap items-baseline gap-2">
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                  m === 'POST' ? 'bg-primary/15 text-primary' : 'bg-white/5 text-ink-soft'
                }`}
              >
                {m}
              </span>
              <code className="font-mono text-[11px] text-ink-soft">{path}</code>
              <span className="text-muted">— {desc}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
