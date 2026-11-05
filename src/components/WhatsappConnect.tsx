'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, Badge, Spinner } from '@/components/ui';
import { useConfirm, useToast } from '@/components/Feedback';

// Own-brand WhatsApp, via Meta Embedded Signup.
//
// By default every clinic's messages go out over the platform's shared verified
// sender and there is nothing to set up. This card is for clinics that want
// their OWN number on the messages instead — the patient sees the clinic's
// WhatsApp identity, not ours.
//
// Meta's flow is a popup, driven by their JS SDK, and it reports its result in
// two halves that we have to join up ourselves:
//   • a `message` event from facebook.com carries the WABA id + phone-number id
//   • the FB.login callback carries the auth `code`
// Neither is sufficient alone, so we stash the first and complete on the second.

type Props = {
  available: boolean;
  appId: string | null;
  configId: string | null;
  graphVersion: string | null;
  connected: boolean;
  verifiedName: string | null;
  displayPhone: string | null;
  canManage: boolean;
  onChange: () => void | Promise<void>;
};

type TemplateRow = { name: string; status: string };

declare global {
  interface Window {
    FB?: {
      init: (o: Record<string, unknown>) => void;
      login: (cb: (r: { authResponse?: { code?: string } }) => void, o: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const SDK_ID = 'facebook-jssdk';

// Human wording for Meta's template review states.
const TEMPLATE_LABEL: Record<string, { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  APPROVED: { text: 'approved', tone: 'success' },
  PENDING: { text: 'in review', tone: 'warning' },
  IN_APPEAL: { text: 'in appeal', tone: 'warning' },
  REJECTED: { text: 'rejected', tone: 'danger' },
  MISSING: { text: 'not created', tone: 'danger' },
};

export function WhatsappConnect(props: Props) {
  const { available, appId, configId, graphVersion, connected, canManage, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The message event fires before the login callback; hold its payload here.
  const signupInfo = useRef<{ wabaId?: string; phoneNumberId?: string }>({});
  // Fires if Meta never calls back at all — see launch().
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  // Load Meta's SDK once, and only when this card is actually usable — no
  // reason to pull a third-party script onto the page for orgs that will never
  // see the button.
  //
  // Readiness is NOT tracked in state. The SDK may already be present (a second
  // mount, a warm client-side navigation), in which case no init callback fires
  // and a state-gated button would stay disabled forever with no explanation.
  // launch() reads window.FB at click time instead and says so if it is early.
  useEffect(() => {
    if (!available || !appId) return;
    if (window.FB || document.getElementById(SDK_ID)) return;
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion || 'v21.0' });
    };
    const s = document.createElement('script');
    s.id = SDK_ID;
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => setError('Could not load WhatsApp sign-up from Meta. Check your connection and reload.');
    document.body.appendChild(s);
  }, [available, appId, graphVersion]);

  // Capture the WABA + phone-number id Meta posts back during the popup flow.
  useEffect(() => {
    if (!available) return;
    function onMessage(ev: MessageEvent) {
      try {
        // Inside the try: a sandboxed frame posts origin "null", which is not a
        // parseable URL, and an exception here would kill the whole handler.
        if (!/(^|\.)facebook\.com$/.test(new URL(ev.origin).hostname)) return;
        const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
          signupInfo.current = { wabaId: data.data?.waba_id, phoneNumberId: data.data?.phone_number_id };
        } else if (data.event === 'CANCEL') {
          // Meta reports the step they abandoned on; we only need to not hang.
          signupInfo.current = {};
        }
      } catch {
        /* not a payload we care about */
      }
    }
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (watchdog.current) clearTimeout(watchdog.current);
    };
  }, [available]);

  // Template review status is advisory: on failure we leave the panel blank
  // rather than erroring the whole card, since the connection itself is fine.
  const fetchTemplates = useCallback(async (): Promise<TemplateRow[] | null> => {
    try {
      const r = await fetch('/api/connectors/whatsapp/templates');
      if (!r.ok) return null;
      const d = await r.json();
      return (d.templates ?? []) as TemplateRow[];
    } catch {
      return null;
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    if (!connected) return;
    const rows = await fetchTemplates();
    if (rows) setTemplates(rows);
  }, [connected, fetchTemplates]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void (async () => {
      const rows = await fetchTemplates();
      if (!cancelled && rows) setTemplates(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, fetchTemplates]);

  function launch() {
    if (!configId) return;
    if (!window.FB) {
      setError('WhatsApp sign-up is still loading — give it a moment and try again.');
      return;
    }
    setError(null);
    signupInfo.current = {};

    // Watchdog. If Meta's app settings are wrong the popup renders an error
    // ("Can't load URL — the domain of this URL isn't included in the app's
    // domains") and FB.login NEVER calls back, so the page sits there saying
    // nothing and the button looks broken. That is exactly how this failed on
    // first use in production. Silence is not an acceptable answer here.
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      setError(
        'Meta didn’t respond. If its window showed “Can’t load URL”, this site’s domain is missing from the Meta app settings (App Domains, Allowed Domains for the JavaScript SDK, and Valid OAuth Redirect URIs) — an admin needs to add it.',
      );
    }, 90_000);

    window.FB.login(
      async (res) => {
        if (watchdog.current) clearTimeout(watchdog.current);
        const code = res?.authResponse?.code;
        const { wabaId, phoneNumberId } = signupInfo.current;
        if (!code) {
          // Covers cancelling AND every failure Meta reports by just closing.
          // This used to return silently unless Meta had sent signup details,
          // so a failed attempt was indistinguishable from a dead button.
          setError(
            wabaId || phoneNumberId
              ? 'WhatsApp sign-up didn’t complete. Please try again.'
              : 'WhatsApp sign-up was cancelled or blocked before it finished. If you didn’t close the window yourself, check that pop-ups are allowed for this site.',
          );
          return;
        }
        if (!wabaId || !phoneNumberId) {
          setError('Meta didn’t return which number you selected. Please try connecting again.');
          return;
        }
        setBusy(true);
        try {
          const r = await fetch('/api/connectors/whatsapp/embedded', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, wabaId, phoneNumberId }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setError(d.error || 'Could not connect WhatsApp.');
            return;
          }
          const failed = d.templates?.failed?.length ?? 0;
          toast(
            failed
              ? `Number connected. ${failed} message template(s) need attention.`
              : 'WhatsApp number connected. Templates are with Meta for review.',
            failed ? 'error' : 'success',
          );
          await onChange();
          await loadTemplates();
        } catch {
          setError('Could not reach the server. Please try again.');
        } finally {
          setBusy(false);
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    );
  }

  async function disconnect() {
    const ok = await confirm({
      title: 'Disconnect your WhatsApp number?',
      message:
        'Messages will go back to being sent from the platform’s shared WhatsApp number. Patients will see that number instead of yours. Nothing else changes.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await fetch('/api/connectors/whatsapp/embedded', { method: 'DELETE' });
    setBusy(false);
    setTemplates(null);
    toast('WhatsApp number disconnected.', 'success');
    await onChange();
  }

  async function retryTemplates() {
    setBusy(true);
    const r = await fetch('/api/connectors/whatsapp/templates', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    toast(
      d.failed?.length ? `${d.failed.length} template(s) still failing.` : 'Templates submitted to Meta.',
      d.failed?.length ? 'error' : 'success',
    );
    await loadTemplates();
  }

  if (!available) return null;

  const pending = templates?.filter((t) => t.status !== 'APPROVED') ?? [];

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-ink">Your own WhatsApp number</h3>
          <p className="mt-0.5 text-xs text-muted">
            Optional. Messages already go out over our verified WhatsApp number — connect your own so patients see your
            clinic’s name and number instead.
          </p>
        </div>
        {connected ? <Badge tone="success">connected</Badge> : <Badge tone="neutral">using ours</Badge>}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      {connected ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-ink">
              {props.verifiedName ?? 'Your business'}
              {props.displayPhone ? <span className="text-muted"> · {props.displayPhone}</span> : null}
            </span>
            {canManage && (
              <Button variant="ghost" onClick={disconnect} disabled={busy}>
                Disconnect
              </Button>
            )}
          </div>

          {templates && templates.length > 0 && (
            <div className="rounded-xl border border-border bg-surface-2 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink">Message templates</span>
                {pending.length === 0 ? (
                  <Badge tone="success">all approved</Badge>
                ) : (
                  <Badge tone="warning">{pending.length} pending</Badge>
                )}
              </div>
              <ul className="mt-2 space-y-1">
                {templates.map((t) => {
                  const label = TEMPLATE_LABEL[t.status] ?? { text: t.status.toLowerCase(), tone: 'neutral' as const };
                  return (
                    <li key={t.name} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted">{t.name.replace(/_/g, ' ')}</span>
                      <Badge tone={label.tone}>{label.text}</Badge>
                    </li>
                  );
                })}
              </ul>
              {pending.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Meta reviews each template, usually within an hour. Until then those messages are sent from our shared
                  number or as SMS, so nothing is lost.
                </p>
              )}
              {canManage && templates.some((t) => t.status === 'MISSING' || t.status === 'REJECTED') && (
                <Button className="mt-2" variant="ghost" onClick={retryTemplates} disabled={busy}>
                  Retry failed templates
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            You’ll need the phone number you want to use (one not already on WhatsApp), and access to your Meta Business
            account. Meta will walk you through verifying it.
          </p>
          {canManage ? (
            <Button onClick={launch} disabled={busy || !configId}>
              {busy ? <Spinner /> : 'Connect WhatsApp'}
            </Button>
          ) : (
            <p className="text-xs text-muted">Ask an admin to connect a WhatsApp number.</p>
          )}
        </div>
      )}
    </Card>
  );
}
