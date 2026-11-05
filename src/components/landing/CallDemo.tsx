'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarCheck, Hash, MessageSquare, Mic, PhoneCall, PhoneOff, User, Volume2 } from 'lucide-react';

// A simulated live phone call: incoming-call header with a running timer,
// speaker tiles that light up with a waveform while "talking", and the
// conversation as live captions (not chat bubbles) — this must read as an AI
// *calling* agent, not a chatbot. Ends with the follow-up actions, holds,
// then loops. SSR renders the finished call so no-JS/SEO sees the full
// exchange.

const SCRIPT = [
  { from: 'caller', text: 'Hi, I saw the 3BHK listing in Gachibowli — is it still available?' },
  { from: 'agent', text: 'It is. Would Saturday morning suit you for a site visit? I can hold 11am.' },
  { from: 'caller', text: 'Haan Saturday theek hai. Budget thoda tight hai though.' },
  { from: 'agent', text: 'Koi baat nahi — main aapka budget note kar leta hoon, team usi range mein options bhejegi.' },
] as const;

const OUTCOMES = [
  { icon: CalendarCheck, text: 'Site visit booked · Sat 11:00' },
  { icon: MessageSquare, text: 'Budget flagged to the team' },
];

const TOTAL = SCRIPT.length + 1; // caption steps, then the outcome row
const HOLD_TICKS = 3; // how long the finished state stays before looping
const SECS_PER_TICK = 3; // fake call-clock seconds added per animation tick

function MiniWave({ bars = 5 }: { bars?: number }) {
  return (
    <div className="waveform" aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} style={{ height: `${45 + Math.round(50 * Math.abs(Math.sin(i * 1.3)))}%`, animationDelay: `${(i * 130) % 700}ms` }} />
      ))}
    </div>
  );
}

function Chip({ pos, depth, delay, children }: { pos: string; depth: number; delay: string; children: React.ReactNode }) {
  return (
    // outer = cursor parallax; inner = gentle float (separate so the two
    // transforms don't fight each other).
    <div
      className={`absolute ${pos} z-20 hidden sm:block`}
      style={{ transform: `translate3d(calc(var(--px) * ${depth}px), calc(var(--py) * ${depth}px), 0)` }}
    >
      <div
        className="animate-float whitespace-nowrap rounded-xl border border-border bg-surface/85 px-3 py-2 text-xs font-medium text-ink shadow-xl backdrop-blur-md"
        style={{ animationDelay: delay }}
      >
        {children}
      </div>
    </div>
  );
}

export function CallDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(TOTAL);

  const step = Math.min(tick, TOTAL);
  const secs = 4 + tick * SECS_PER_TICK; // call already ringing a few seconds in
  const timer = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  // Who is talking right now (drives the speaker-tile waveforms).
  const currentLine = step > 0 && step <= SCRIPT.length ? SCRIPT[step - 1] : null;
  const agentTalking = currentLine?.from === 'agent';
  const callerTalking = currentLine?.from === 'caller';

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let s = 0;
    setTick(0);
    const id = setInterval(() => {
      s = s > TOTAL + HOLD_TICKS ? 0 : s + 1;
      setTick(s);
    }, 1400);
    return () => clearInterval(id);
  }, []);

  function onMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', (((e.clientX - r.left) / r.width - 0.5) * 2).toFixed(3));
    el.style.setProperty('--py', (((e.clientY - r.top) / r.height - 0.5) * 2).toFixed(3));
  }
  function reset() {
    ref.current?.style.setProperty('--px', '0');
    ref.current?.style.setProperty('--py', '0');
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={reset}
      className="relative mx-auto w-full max-w-[440px] select-none"
      style={{ ['--px' as string]: 0, ['--py' as string]: 0 } as React.CSSProperties}
    >
      {/* Aurora glow behind the card */}
      <div className="pointer-events-none absolute -inset-16 -z-10">
        <div className="animate-aurora absolute left-[4%] top-[6%] h-60 w-60 rounded-full bg-primary/25 blur-[80px]" />
        <div
          className="animate-aurora absolute bottom-[4%] right-[2%] h-60 w-60 rounded-full bg-success/20 blur-[80px]"
          style={{ animationDelay: '-7s' }}
        />
      </div>

      {/* The call screen */}
      <div
        className="overflow-hidden rounded-3xl border border-border bg-surface/90 shadow-2xl backdrop-blur-md"
        style={{ transform: 'translate3d(calc(var(--px) * 8px), calc(var(--py) * 8px), 0)' }}
      >
        {/* Call header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-success/15 text-success">
            <PhoneCall className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">Incoming call · +91 98XXX XX210</div>
            {/* Deliberately a made-up name. An earlier version said "Aster",
                which is a real Indian hospital group — on a marketing page that
                reads as a customer we do not have. */}
            <div className="truncate text-xs text-muted">Example brokerage — answered by an AI agent</div>
          </div>
          <div className="text-right">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-success">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              Live
            </span>
            <div className="mt-1 font-mono text-xs tabular-nums text-ink-soft">{timer}</div>
          </div>
        </div>

        {/* Speakers on the line */}
        <div className="grid grid-cols-2 gap-3 px-5 pt-4">
          {/* Caller */}
          <div className={`flex items-center gap-3 rounded-2xl border px-3.5 py-3 transition ${callerTalking ? 'border-border bg-surface-2' : 'border-border/60'}`}>
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-soft ring-1 ring-inset ring-border">
              <User className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-ink">Caller</div>
              <div className="mt-0.5 h-3.5 w-12 text-muted">
                {callerTalking ? <MiniWave bars={9} /> : <span className="text-[10px]">listening…</span>}
              </div>
            </div>
          </div>
          {/* AI agent */}
          <div className={`flex items-center gap-3 rounded-2xl border px-3.5 py-3 transition ${agentTalking ? 'border-primary/40 bg-primary-soft' : 'border-border/60'}`}>
            <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-[#7a6df0] shadow-tile-raised">
              {agentTalking && <span className="absolute inset-0 animate-ping rounded-full bg-primary/40" />}
              <div className="relative h-3.5 w-5 text-white/95">
                <MiniWave bars={5} />
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-ink">Agent · AI</div>
              <div className="mt-0.5 h-3.5 w-12 text-primary">
                {agentTalking ? <MiniWave bars={9} /> : <span className="text-[10px] text-muted">listening…</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Live transcript captions */}
        <div className="min-h-[188px] space-y-2.5 px-5 py-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted">Live transcript</div>
          {SCRIPT.map((m, i) => {
            const spoken = step > i;
            const current = step === i + 1;
            const agent = m.from === 'agent';
            return (
              <div
                key={i}
                className={`flex items-baseline gap-2.5 transition-all duration-500 ${
                  spoken ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
                } ${!current && spoken ? 'opacity-60' : ''}`}
              >
                <span className={`w-12 shrink-0 text-[10px] font-semibold uppercase tracking-wider ${agent ? 'text-primary' : 'text-muted'}`}>
                  {agent ? 'Agent' : 'Caller'}
                </span>
                <p className="text-sm leading-snug text-ink">{m.text}</p>
              </div>
            );
          })}

          {/* Post-call actions */}
          <div
            className={`flex flex-wrap gap-2 pt-1.5 transition-all duration-500 ${
              step >= TOTAL ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
            }`}
          >
            {OUTCOMES.map((o) => {
              const Icon = o.icon;
              return (
                <span
                  key={o.text}
                  className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-medium text-success"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {o.text}
                </span>
              );
            })}
          </div>
        </div>

        {/* Call controls */}
        <div className="flex items-center justify-center gap-4 border-t border-border bg-surface-2/50 px-5 py-3.5">
          {[Mic, Hash, Volume2].map((Icon, i) => (
            <span key={i} className="grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-ink-soft">
              <Icon className="h-4 w-4" />
            </span>
          ))}
          <span className="grid h-9 w-9 place-items-center rounded-full bg-danger text-white shadow-tile">
            <PhoneOff className="h-4 w-4" />
          </span>
        </div>
      </div>

      {/* Floating differentiator chips */}
      <Chip pos="-left-6 -top-5" depth={26} delay="0s">😊 Real emotion in every voice</Chip>
      <Chip pos="-right-7 -bottom-8" depth={34} delay="-2s">⚡ Replies in under a second</Chip>
      <Chip pos="-left-8 -bottom-5" depth={30} delay="-4s">🔌 Calendar · CRM · SMS</Chip>
    </div>
  );
}
