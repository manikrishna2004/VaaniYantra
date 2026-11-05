'use client';

import { useState } from 'react';
import { PhoneOff, TrendingDown, PhoneIncoming } from 'lucide-react';

/**
 * "What is your switchboard dropping?"
 *
 * The page's anchor. It turns an abstract pitch ("never miss a call") into a
 * number in the reader's own currency BEFORE they reach pricing — a ₹9,999 plan
 * reads very differently underneath a figure you just watched appear.
 *
 * ⚠ EVERY NUMBER HERE COMES FROM THE READER'S OWN SLIDERS.
 * There is no "hospitals like yours see X" benchmark, no invented industry
 * average and no customer count, because we have no data for any of that and
 * inventing it on a healthcare site is not something we do. The defaults are a
 * starting position to drag, and the copy says so.
 *
 * Calibrated for a multi-speciality hospital switchboard (50–1500 calls/day),
 * not a single-doctor clinic.
 */

/** Stated inline, not hidden in the maths. Deliberately not 100%. */
const RECOVERY_RATE = 0.6;
/** Of the calls that go unanswered, how many were a real booking intent. */
const BOOKING_INTENT = 1 / 3;
const OPEN_DAYS = 26;

export function SwitchboardMath() {
  const [callsPerDay, setCallsPerDay] = useState(300);
  const [missedPct, setMissedPct] = useState(25);
  const [visitValue, setVisitValue] = useState(800);

  const missedPerMonth = Math.round(callsPerDay * (missedPct / 100) * OPEN_DAYS);
  const lostPatients = Math.round(missedPerMonth * BOOKING_INTENT);
  const lostRevenue = lostPatients * visitValue;
  const recoverable = Math.round(lostRevenue * RECOVERY_RATE);

  const inr = (n: number) => '₹' + n.toLocaleString('en-IN');

  return (
    <div className="grid gap-8 rounded-3xl border border-border bg-surface p-6 shadow-tile sm:p-8 lg:grid-cols-[1fr_320px] lg:gap-10">
      <div className="space-y-7">
        <Slider
          label="Calls your switchboard takes on a normal day"
          value={callsPerDay}
          min={50}
          max={1500}
          step={25}
          onChange={setCallsPerDay}
          display={callsPerDay.toLocaleString('en-IN')}
        />
        <Slider
          label="Share that ring out, queue too long, or land after hours"
          value={missedPct}
          min={5}
          max={60}
          step={5}
          onChange={setMissedPct}
          display={`${missedPct}%`}
        />
        <Slider
          label="What one new consultation is worth"
          value={visitValue}
          min={200}
          max={5000}
          step={100}
          onChange={setVisitValue}
          display={inr(visitValue)}
        />
        <p className="text-xs leading-relaxed text-muted">
          These are your numbers, not ours — drag them until they match your practice. The maths assumes{' '}
          {OPEN_DAYS} working days and that only <strong className="font-semibold text-ink-soft">one in three</strong>{' '}
          unanswered calls was a patient who would have booked. We keep that deliberately cautious rather than
          quoting an industry average we cannot stand behind.
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl bg-surface-2 p-6">
        <div>
          <Metric icon={PhoneIncoming} label="Calls a month" />
          <div className="h-display mt-1 text-2xl font-semibold tabular-nums text-ink-soft">
            {(callsPerDay * OPEN_DAYS).toLocaleString('en-IN')}
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <Metric icon={PhoneOff} label="Nobody answers" />
          <div className="h-display mt-1 text-2xl font-semibold tabular-nums text-ink">
            {missedPerMonth.toLocaleString('en-IN')}
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <Metric icon={TrendingDown} label="Walks to another hospital" />
          {/* The one number this whole section exists to produce. Danger red is
              right here — this is a loss, and the palette reserves red for
              exactly that. */}
          <div className="h-display mt-1 text-4xl font-semibold tabular-nums text-danger">{inr(lostRevenue)}</div>
          <div className="mt-1 text-xs text-muted">
            roughly {lostPatients.toLocaleString('en-IN')} patient{lostPatients === 1 ? '' : 's'} a month
          </div>
        </div>

        <div className="mt-1 rounded-xl bg-primary-soft p-4 ring-1 ring-inset ring-primary/20">
          <p className="text-xs leading-relaxed text-ink-soft">
            An agent that picks up every one of them — all night, all at once, no queue — puts back around
          </p>
          <p className="h-display mt-1.5 text-2xl font-semibold tabular-nums text-primary">{inr(recoverable)}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            taking {Math.round(RECOVERY_RATE * 100)}% as the share of callers happy to book with an assistant
            rather than wait for a person
          </p>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label }: { icon: typeof PhoneOff; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display: string;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm text-ink-soft">{label}</span>
        <span className="h-display shrink-0 text-lg font-semibold tabular-nums text-ink">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-teal mt-3 w-full"
        aria-label={label}
      />
    </label>
  );
}
