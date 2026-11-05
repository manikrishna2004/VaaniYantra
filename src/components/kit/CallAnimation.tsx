'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, MessageSquare, PhoneCall, User } from 'lucide-react';

// The kit page's hero visual: a phone call being answered, rather than a
// diagram of how it works. Rings, connects, runs a short booking conversation
// as live captions with a waveform on whoever is speaking, shows what the call
// produced, then loops.
//
// The script is the kit's own dental-clinic example (agent "Maya"), so what a
// buyer watches here is what the download does out of the box.
//
// SSR and reduced-motion both render the finished call, so a visitor who never
// runs the animation still sees the whole exchange.

const SCRIPT = [
  { from: 'caller', text: 'Hi, can I get a cleaning this week?' },
  { from: 'agent', text: 'Of course. I have Thursday at 4:30 or Friday at 11. Which suits you?' },
  { from: 'caller', text: 'Thursday 4:30 works.' },
  { from: 'agent', text: 'Booked. I’ve sent the details to your WhatsApp.' },
] as const;

const OUTCOMES = [
  { icon: CalendarCheck, text: 'Booked · Thu 4:30 PM' },
  { icon: MessageSquare, text: 'WhatsApp confirmation sent' },
];

// Ticks: 0 ringing, 1..SCRIPT.length captions, then outcomes, then a hold.
const RING_TICKS = 1;
const DONE = RING_TICKS + SCRIPT.length + 1;
const HOLD_TICKS = 3;
const TICK_MS = 2200;

function Wave({ active }: { active: boolean }) {
  return (
    <div className={`h-5 transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-20'}`} aria-hidden>
      <div className="waveform">
        {Array.from({ length: 7 }).map((_, i) => (
          <span
            key={i}
            style={{
              height: `${40 + Math.round(55 * Math.abs(Math.sin(i * 1.7)))}%`,
              animationDelay: `${(i * 110) % 700}ms`,
              animationPlayState: active ? 'running' : 'paused',
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function CallAnimation() {
  const [tick, setTick] = useState(DONE);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setTick(0);
    const id = setInterval(() => setTick((t) => (t + 1) % (DONE + HOLD_TICKS)), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const ringing = tick < RING_TICKS;
  const shown = Math.min(Math.max(tick - RING_TICKS + 1, 0), SCRIPT.length);
  const speaking = !ringing && shown > 0 && shown <= SCRIPT.length && tick < DONE - 1 ? SCRIPT[shown - 1].from : null;
  const outcomes = tick >= DONE - 1;
  const seconds = ringing ? 0 : Math.min(tick, DONE) * 4;
  const clock = `0:${String(seconds).padStart(2, '0')}`;

  return (
    <div className="rounded-2xl border border-border-inverse bg-surface-inverse p-6 sm:p-7">
      {/* Call header */}
      <div className="flex items-center gap-4">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          {ringing && (
            <>
              <span className="absolute inset-0 animate-ping rounded-full bg-primary-on-dark/40" />
              <span className="absolute -inset-2 animate-ping rounded-full bg-primary-on-dark/20 [animation-delay:300ms]" />
            </>
          )}
          <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary-on-dark text-bg-inverse">
            <PhoneCall className={`h-5 w-5 ${ringing ? 'animate-pulse' : ''}`} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display font-semibold text-ink-inverse">Sunrise Dental</p>
          <p className="text-xs text-muted-inverse">
            {ringing ? 'Incoming call…' : 'Maya · AI receptionist'}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 font-mono text-xs ${
            ringing ? 'bg-surface-inverse-2 text-muted-inverse' : 'bg-primary-on-dark/15 text-primary-on-dark'
          }`}
        >
          {ringing ? 'Ringing' : `● ${clock}`}
        </span>
      </div>

      {/* Speakers */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        {[
          { who: 'caller', label: 'Caller', icon: User },
          { who: 'agent', label: 'Maya', icon: PhoneCall },
        ].map(({ who, label, icon: Icon }) => (
          <div
            key={who}
            className={`flex items-center justify-between rounded-xl border px-3 py-2.5 transition-colors duration-300 ${
              speaking === who ? 'border-primary-on-dark/60 bg-primary-on-dark/10' : 'border-border-inverse'
            }`}
          >
            <span className="flex items-center gap-2 text-xs text-ink-inverse-soft">
              <Icon className="h-3.5 w-3.5" /> {label}
            </span>
            <span className="text-primary-on-dark">
              <Wave active={speaking === who} />
            </span>
          </div>
        ))}
      </div>

      {/* Live captions */}
      <div className="mt-5 min-h-[168px] space-y-3 text-sm" aria-live="off">
        {SCRIPT.slice(0, ringing ? 0 : shown).map((line, i) => (
          <p
            key={i}
            className={`animate-in leading-relaxed ${line.from === 'agent' ? 'text-ink-inverse' : 'text-ink-inverse-soft'}`}
          >
            <span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-muted-inverse">
              {line.from === 'agent' ? 'Maya' : 'Caller'}
            </span>
            {line.text}
          </p>
        ))}
      </div>

      {/* What the call produced */}
      <div className={`mt-4 flex flex-wrap gap-2 transition-opacity duration-500 ${outcomes ? 'opacity-100' : 'opacity-0'}`}>
        {OUTCOMES.map(({ icon: Icon, text }) => (
          <span
            key={text}
            className="flex items-center gap-1.5 rounded-lg border border-border-inverse bg-surface-inverse-2 px-2.5 py-1.5 text-xs text-ink-inverse"
          >
            <Icon className="h-3.5 w-3.5 text-primary-on-dark" /> {text}
          </span>
        ))}
      </div>
    </div>
  );
}
