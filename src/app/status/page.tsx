// Public status page: live health of the web app + database and the realtime
// voice service. Server-rendered on every request (no cache) so what you see
// is the current state; refresh to re-check.

import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Status',
  description: 'Live operational status of the VaaniYantra platform.',
};

type ComponentStatus = { name: string; description: string; up: boolean; detail?: string };

async function checkJson(url: string, timeoutMs = 4000): Promise<{ ok: boolean; body?: any }> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false };
  }
}

export default async function StatusPage() {
  const base = process.env.APP_BASE_URL || 'http://localhost:3000';
  const [web, voice] = await Promise.all([
    checkJson(`${base}/api/health`),
    checkJson(`${base.replace(/\/$/, '')}/health`),
  ]);

  const components: ComponentStatus[] = [
    {
      name: 'Web application & API',
      description: 'Dashboard, public API, webhooks',
      up: web.ok,
    },
    {
      name: 'Database',
      description: 'Call history, agents, appointments',
      up: web.ok && web.body?.db === 'up',
    },
    {
      name: 'Voice service',
      description: 'Live calls (Twilio & Exotel media streams)',
      up: voice.ok,
    },
  ];
  const allUp = components.every((c) => c.up);
  const checkedAt = new Date().toUTCString();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Platform status</h1>
      <div
        className={`mt-6 rounded-2xl border p-5 ${
          allUp ? 'border-accent/40 bg-accent/5' : 'border-danger/40 bg-danger/5'
        }`}
      >
        <p className={`text-lg font-medium ${allUp ? 'text-accent' : 'text-danger'}`}>
          {allUp ? 'All systems operational' : 'Partial outage detected'}
        </p>
        <p className="mt-1 text-xs text-muted">Checked live at {checkedAt}. Refresh to re-check.</p>
      </div>

      <ul className="mt-8 divide-y divide-border rounded-2xl border border-border bg-surface">
        {components.map((c) => (
          <li key={c.name} className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-sm font-medium text-ink">{c.name}</p>
              <p className="text-xs text-muted">{c.description}</p>
            </div>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                c.up ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'
              }`}
            >
              {c.up ? 'Operational' : 'Down'}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-sm text-ink-soft">
        Having trouble that this page doesn&rsquo;t reflect?{' '}
        <Link href="/contact" className="text-primary underline">
          Contact us
        </Link>
        .
      </p>
    </main>
  );
}
