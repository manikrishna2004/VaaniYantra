import { Check } from 'lucide-react';

// The whole of pricing, on two cards.
//
// This replaces a nine-plan grid with product tabs, a "Recommended" ring and a
// per-plan feature ladder. None of that survived the move to a single rate,
// and none of it should: the entire commercial proposition is now one number
// per minute, and a page that spends a screen deciding between tiers implies a
// decision the buyer no longer has to make.
//
// The rates come from the plan catalogue via the server so a rate changed in
// /admin shows here too — the same reason the old grid took its prices from
// the server rather than from a module-scope snapshot.

export type RateCardProps = {
  ratePerMinute: number;
  scaleRatePerMinute: number;
  /** Marketing mode: where "Talk to us" points. */
  contactHref: string;
};

const INCLUDED = [
  'Answers every call at once — no queue, no after-hours gap',
  'Books onto each consultant’s own calendar',
  'The patient chatbot, prescriptions and reports included',
  'Your own numbers, your own hospital system',
  'Unlimited agents, departments and branches',
];

const rate = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

export function RateCard({ ratePerMinute, scaleRatePerMinute, contactHref }: RateCardProps) {
  return (
    <div className="mx-auto grid max-w-3xl items-start gap-4 sm:grid-cols-2">
      <div className="relative rounded-2xl border border-primary/60 bg-surface p-6 shadow-tile-raised ring-1 ring-primary/20">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Standard</h3>
        <p className="mt-2 h-display text-4xl font-semibold">
          ₹{rate(ratePerMinute)}
          <span className="text-base font-normal text-muted"> / minute</span>
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          You pay for the minutes your agent actually spends on the phone, billed at the end of the month. No
          monthly fee, no minimum, nothing bought up front.
        </p>
        <ul className="mt-5 space-y-2.5 text-sm text-ink-soft">
          {INCLUDED.map((f) => (
            <li key={f} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <a
          href={contactHref}
          className="mt-6 block w-full rounded-xl bg-primary px-4 py-2.5 text-center text-sm font-medium text-on-primary transition hover:bg-primary-hover"
        >
          Talk to us
        </a>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">At scale</h3>
        <p className="mt-2 h-display text-4xl font-semibold">
          ₹{rate(scaleRatePerMinute)}
          <span className="text-base font-normal text-muted"> / minute</span>
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Planning high call volumes across several branches or departments? The rate comes down. Tell us what your
          switchboard handles in a month and we will confirm it in writing.
        </p>
        <ul className="mt-5 space-y-2.5 text-sm text-ink-soft">
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>Everything in Standard, at the lower rate</span>
          </li>
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>Department routing across branches</span>
          </li>
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>Integration work scoped with your team</span>
          </li>
        </ul>
        <a
          href={contactHref}
          className="mt-6 block w-full rounded-xl border border-border-strong bg-surface-2 px-4 py-2.5 text-center text-sm font-medium text-ink transition hover:border-primary/60"
        >
          Tell us your volume
        </a>
      </div>
    </div>
  );
}
