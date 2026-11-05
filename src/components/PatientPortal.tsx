'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { renderPrescription, type RxItemLike } from '@/lib/patients/prescription';
import { CalendarClock, Download, FileText, MessageCircle, Send, Stethoscope } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';

// The patient's whole experience: a chat with their clinic's assistant, plus a
// Records tab holding what the doctor filed. Deliberately one screen with two
// tabs — the people using this are on a phone, often older, and often opening
// it once to answer a single question ("what did she prescribe?").

type Doc = { id: string; name: string; mimeType: string; sizeBytes: number };
type Visit = {
  id: string;
  visitedAt: string;
  expertName: string | null;
  service: string | null;
  diagnosis: string | null;
  prescription: string | null;
  items?: RxItemLike[];
  advice: string | null;
  followUpAt: string | null;
  documents: Doc[];
};
type Appointment = {
  id: string;
  service: string;
  expertName: string | null;
  startAt: string;
  timezone: string | null;
};
type Me = {
  portal: { name: string; greeting: string | null; allowRecords: boolean; allowDownloads: boolean };
  contact: { name: string };
  visits: Visit[];
  appointments: Appointment[];
  history: { role: string; text: string; createdAt: string }[];
};

type Msg = { role: 'user' | 'model'; text: string };

// 'anonymous' is the sign-in screen. 'rejected' is the specific case of a
// number that verified but has no patient record here — a different situation
// that must not share a message, because telling someone to "try again" when
// the clinic simply doesn't have them on file sends them round in circles.
type State = 'checking' | 'ready' | 'anonymous' | 'rejected';

export function PatientPortal({
  slug,
  name,
  greeting,
}: {
  slug: string;
  name: string;
  greeting: string | null;
}) {
  const [state, setState] = useState<State>('checking');
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<'chat' | 'records'>('chat');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Returns the patient's data, or the reason they can't be shown any.
  const loadMe = useCallback(async (): Promise<Me | { denied: 'anonymous' | 'rejected' }> => {
    const res = await fetch(`/api/portal/${slug}/me`, { cache: 'no-store' });
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    return { denied: body.reason === 'rejected' ? 'rejected' : 'anonymous' };
  }, [slug]);

  // Adopt a signed-in patient's data into the chat view.
  const enter = useCallback(
    (data: Me) => {
      setMe(data);
      setMessages(
        data.history.length
          ? data.history.map((h) => ({ role: h.role === 'model' ? 'model' : 'user', text: h.text }))
          : [{ role: 'model', text: greeting || defaultGreeting(name, data.contact.name) }],
      );
      setState('ready');
    },
    [greeting, name],
  );

  // On arrival, resume the session from a previous visit, else show sign-in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Links sent before sign-in codes existed carry a `?k=` token. It no
      // longer means anything, but it is still stripped from the address bar:
      // the old secret should not linger in history, a screenshot, or a Referer
      // header. Ignoring it (rather than erroring) is what makes every one of
      // those already-sent links land politely on the sign-in screen.
      const url = new URL(window.location.href);
      if (url.searchParams.has('k')) {
        url.searchParams.delete('k');
        window.history.replaceState({}, '', url.pathname + url.search);
      }

      const data = await loadMe();
      if (cancelled) return;
      if ('denied' in data) {
        setState('anonymous');
        return;
      }
      enter(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, loadMe, enter]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setSending(true);
    try {
      const res = await fetch(`/api/portal/${slug}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages((m) => [...m, { role: 'model', text: body.error || 'Something went wrong. Please try again.' }]);
        return;
      }
      setMessages((m) => [...m, { role: 'model', text: body.reply }]);
      // A booking or cancellation happened — pull the panels back into line.
      // If the session died mid-conversation, keep what's on screen rather than
      // yanking the chat away; the next reload will show the proper message.
      if (body.mutated) {
        const fresh = await loadMe();
        if (!('denied' in fresh)) setMe(fresh);
      }
    } catch {
      setMessages((m) => [...m, { role: 'model', text: 'Could not reach the clinic assistant. Please try again.' }]);
    } finally {
      setSending(false);
    }
  }

  if (state === 'checking') {
    return (
      <Shell name={name}>
        <div className="flex flex-1 items-center justify-center py-20 text-muted">
          <Spinner />
        </div>
      </Shell>
    );
  }

  // A number that verified but isn't on the clinic's books. Distinct from the
  // sign-in screen: retrying achieves nothing, so don't invite it.
  if (state === 'rejected') {
    return (
      <Shell name={name}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-20 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
            <Stethoscope className="h-6 w-6" />
          </div>
          <h2 className="h-display text-lg font-semibold">We don&apos;t have your records yet</h2>
          <p className="max-w-sm text-sm text-muted">
            There&apos;s no patient file at {name} for that mobile number. If you&apos;ve visited under a different
            number, try that one — otherwise please call the clinic and they can add you.
          </p>
          <button
            type="button"
            onClick={() => setState('anonymous')}
            className="mt-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            Try another number
          </button>
        </div>
      </Shell>
    );
  }

  if (state !== 'ready' || !me) {
    return (
      <Shell name={name}>
        <SignIn slug={slug} name={name} onSignedIn={enter} onNoRecord={() => setState('rejected')} />
      </Shell>
    );
  }

  const showRecords = me.portal.allowRecords;

  return (
    <Shell name={name} subtitle={`Hi ${me.contact.name.split(' ')[0]} 👋`}>
      {showRecords && (
        <div className="flex shrink-0 gap-1 border-b border-border px-3">
          <Tab active={tab === 'chat'} onClick={() => setTab('chat')} icon={MessageCircle} label="Chat" />
          <Tab
            active={tab === 'records'}
            onClick={() => setTab('records')}
            icon={FileText}
            label={`Records${me.visits.length ? ` (${me.visits.length})` : ''}`}
          />
        </div>
      )}

      {tab === 'chat' || !showRecords ? (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
            {me.appointments.length > 0 && <NextVisit appointment={me.appointments[0]} />}
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} text={m.text} />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Spinner /> typing…
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={send} className="flex shrink-0 items-end gap-2 border-t border-border bg-surface p-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              maxLength={1000}
              placeholder="Ask about your prescription, timings, or your next visit…"
              aria-label="Message"
              className="input max-h-32 min-h-[44px] flex-1 resize-none py-3"
            />
            <Button type="submit" disabled={!draft.trim() || sending} aria-label="Send message" className="h-11 w-11 px-0">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </>
      ) : (
        <Records slug={slug} visits={me.visits} allowDownloads={me.portal.allowDownloads} />
      )}
    </Shell>
  );
}

function defaultGreeting(clinic: string, patient: string): string {
  const first = patient.split(' ')[0];
  return `Hi ${first}! I'm the assistant for ${clinic}. You can ask me about your prescription, what the doctor advised, or your next appointment.`;
}

/**
 * Phone number, then the code texted to it.
 *
 * Two steps rather than one screen, because a patient on a phone has to leave
 * the browser to read their SMS and come back — asking for both at once means
 * re-typing a number they already gave.
 *
 * The messages here never say whether a number belongs to a patient. The server
 * behaves identically either way (see /otp/start), and leaking it in the UI
 * would give away exactly what the server takes care not to.
 */
function SignIn({
  slug,
  name,
  onSignedIn,
  onNoRecord,
}: {
  slug: string;
  name: string;
  onSignedIn: (me: Me) => void;
  onNoRecord: () => void;
}) {
  const [step, setStep] = useState<'phone' | 'code' | 'who'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  // Set when the verified number belongs to a whole family.
  const [candidates, setCandidates] = useState<{ id: string; name: string }[]>([]);
  const [selectionToken, setSelectionToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  // Counts down the resend cooldown the server enforces, so the button isn't
  // offered before it can work.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !phone.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${slug}/otp/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not send a code just now.');
        return;
      }
      setStep('code');
      setResendIn(60);
    } catch {
      setError('Could not reach the clinic’s assistant. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  async function enterWithSession() {
    const me = await fetch(`/api/portal/${slug}/me`, { cache: 'no-store' });
    if (!me.ok) {
      setError('Signed in, but could not load your records. Please try again.');
      return;
    }
    onSignedIn(await me.json());
  }

  async function choose(contactId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${slug}/otp/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectionToken, contactId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error || 'Please sign in again.');
        setStep('phone');
        setCode('');
        return;
      }
      await enterWithSession();
    } catch {
      setError('Could not reach the clinic’s assistant. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.trim().length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${slug}/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The code was right but there's no patient file for this number.
        if (body.reason === 'anonymous') {
          onNoRecord();
          return;
        }
        setError(body.error || 'That code is not right.');
        setCode('');
        return;
      }
      // Several patients share this number — ask which one before signing in.
      if (body.needsSelection) {
        setCandidates(body.candidates ?? []);
        setSelectionToken(body.selectionToken ?? '');
        setStep('who');
        return;
      }
      await enterWithSession();
    } catch {
      setError('Could not reach the clinic’s assistant. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
        <Stethoscope className="h-6 w-6" />
      </div>

      {step === 'who' ? (
        <>
          <h2 className="h-display text-lg font-semibold">Who is this for?</h2>
          <p className="max-w-sm text-sm text-muted">
            This number is used by more than one patient at {name}. Pick whose records you want to see.
          </p>
          <div className="mt-1 w-full max-w-xs space-y-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => choose(c.id)}
                className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-base text-ink transition hover:border-primary disabled:opacity-50"
              >
                {c.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setCode('');
              setCandidates([]);
            }}
            className="text-sm text-muted underline-offset-4 hover:underline"
          >
            Use a different number
          </button>
        </>
      ) : step === 'phone' ? (
        <>
          <h2 className="h-display text-lg font-semibold">{name}</h2>
          <p className="max-w-sm text-sm text-muted">
            Enter the mobile number the clinic has for you. We&apos;ll text you a code so only you can see your
            prescriptions and visits.
          </p>
          <form onSubmit={requestCode} className="mt-1 w-full max-w-xs space-y-3">
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              aria-label="Your mobile number"
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-center text-base tracking-wide text-ink outline-none focus:border-primary"
            />
            <Button type="submit" className="w-full" disabled={busy || !phone.trim()}>
              {busy ? <Spinner /> : 'Send me a code'}
            </Button>
          </form>
        </>
      ) : (
        <>
          <h2 className="h-display text-lg font-semibold">Enter your code</h2>
          <p className="max-w-sm text-sm text-muted">
            If {phone.trim()} is on file at {name}, we&apos;ve just texted a 6-digit code. It expires in 5 minutes.
          </p>
          <form onSubmit={submitCode} className="mt-1 w-full max-w-xs space-y-3">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              aria-label="The 6-digit code"
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-center text-2xl tracking-[0.4em] text-ink outline-none focus:border-primary"
            />
            <Button type="submit" className="w-full" disabled={busy || code.length < 4}>
              {busy ? <Spinner /> : 'Sign in'}
            </Button>
          </form>
          <div className="flex items-center gap-4 text-sm">
            <button
              type="button"
              onClick={() => {
                setStep('phone');
                setCode('');
                setError(null);
              }}
              className="text-muted underline-offset-4 hover:underline"
            >
              Change number
            </button>
            <button
              type="button"
              onClick={() => requestCode()}
              disabled={busy || resendIn > 0}
              className="text-primary underline-offset-4 hover:underline disabled:text-muted disabled:no-underline"
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
            </button>
          </div>
        </>
      )}

      {error && <p className="max-w-xs text-sm text-danger">{error}</p>}
    </div>
  );
}

function Shell({ name, subtitle, children }: { name: string; subtitle?: string; children: React.ReactNode }) {
  return (
    // Fixed viewport height with the scroll confined to the message list: the
    // composer must stay put when a phone keyboard opens.
    <div className="mx-auto flex h-[100dvh] max-w-2xl flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3.5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
          <Stethoscope className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="h-display truncate text-base font-semibold">{name}</div>
          {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
        </div>
      </header>
      {children}
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageCircle;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-sm transition ${
        active ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Bubble({ role, text }: { role: 'user' | 'model'; text: string }) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          mine ? 'bg-primary text-on-primary' : 'bg-surface-2 text-ink'
        }`}
      >
        {text}
      </div>
    </div>
  );
}

function NextVisit({ appointment }: { appointment: Appointment }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 text-xs">
        <div className="font-medium text-ink">Next visit</div>
        <div className="truncate text-muted">
          {fmtDateTime(appointment.startAt, appointment.timezone)}
          {appointment.expertName ? ` · ${appointment.expertName}` : ''}
        </div>
      </div>
    </div>
  );
}

function Records({
  slug,
  visits,
  allowDownloads,
}: {
  slug: string;
  visits: Visit[];
  allowDownloads: boolean;
}) {
  if (visits.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <FileText className="h-6 w-6 text-muted" />
        <p className="text-sm text-muted">
          Nothing here yet. After your next consultation, your prescription will appear on this tab.
        </p>
      </div>
    );
  }
  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
      {visits.map((v) => (
        <article key={v.id} className="card space-y-2.5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="h-display text-sm font-semibold">
              {fmtDate(v.visitedAt)}
              {v.expertName ? ` · ${v.expertName}` : ''}
            </h3>
            {v.service && <span className="text-xs text-muted">{v.service}</span>}
          </div>
          {v.diagnosis && <Line label="Diagnosis" value={v.diagnosis} />}
          <RxLines visit={v} />
          {v.advice && <Line label="Advice" value={v.advice} />}
          {v.followUpAt && <Line label="Follow-up" value={fmtDate(v.followUpAt)} />}
          {allowDownloads && v.documents.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {v.documents.map((d) => (
                <a
                  key={d.id}
                  href={`/api/portal/${slug}/documents/${d.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-3 py-1.5 text-xs text-ink transition hover:border-primary/60"
                >
                  <Download className="h-3.5 w-3.5 text-primary" />
                  {d.name}
                </a>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

/**
 * The patient's own view of their medicines.
 *
 * Each line is one medicine as a whole sentence — "Amoxicillin 500 mg — 1
 * tablet, twice a day (BD), by mouth, for 5 days, after food" — because this is
 * read on a phone, often by someone unwell, and often by a family member who was
 * not in the room. Cards rather than a dense table for the same reason.
 */
function RxLines({ visit }: { visit: Visit }) {
  const rx = renderPrescription(visit);
  if (rx.kind === 'none') return null;
  if (rx.kind === 'text') return <Line label="Prescription" value={rx.text} />;
  return (
    <div className="text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Prescription</span>
      <ul className="mt-1.5 space-y-1.5">
        {rx.lines.map((line, i) => (
          <li key={i} className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-ink">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <p className="mt-0.5 whitespace-pre-wrap text-ink">{value}</p>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function fmtDateTime(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz || undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
