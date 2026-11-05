import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { LANGUAGES, INDIAN_LANGUAGE_COUNT } from '@/lib/constants';
import { RATE_PER_MINUTE_INR } from '@/lib/billing/catalogue';
import { SOLUTIONS } from '@/lib/verticals/solutions';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { CallDemo } from '@/components/landing/CallDemo';
import { Reveal } from '@/components/landing/motion';

// Public marketing landing page for the AGENCY.
//
// WHO THIS PAGE IS WRITTEN FOR: an owner or operator with a phone that keeps
// ringing out — in any of six trades. That is a different reader from the
// hospital administrator the previous version addressed, and it drives three
// things:
//
//   1. The offer is a SERVICE, not a product. "We build the automation, we run
//      it too." Nobody signs up; every path off this page is a conversation.
//   2. The industry grid is the second thing on the page, because the first
//      question this reader has is "do you do my kind of business?" — and a
//      visitor who cannot find themselves in the first screenful leaves.
//   3. Deployment is on the page, not buried. "Can it run in our cloud?" is the
//      question that stalls the deals worth having.
//
// ⚠ NO INVENTED SOCIAL PROOF. No testimonials, customer counts, logos or
// "trusted by N businesses" anywhere here, because none of it is true yet.
// Proof is by demonstration (the live call), by specificity, and by linking the
// real /security and /status pages. Where a number would help and we do not
// have it, it is a bracketed placeholder — see the build fee in PRICING.
//
// This page renders on the DARK marketing scale. The signed-in app is light and
// shares nothing with it but the token names.

const HOW = [
  {
    step: '01',
    title: 'We listen to your calls',
    desc: 'A week of real enquiries, so the agent is built around what people actually ask rather than what a template assumes.',
  },
  {
    step: '02',
    title: 'We build the automation',
    desc: 'The agent, the booking logic, the follow-up messages, and the handoff into whatever system you already run.',
  },
  {
    step: '03',
    title: 'We deploy and meter it',
    desc: 'In our cloud or yours, with every minute metered and visible to you the same day it is spoken.',
  },
  {
    step: '04',
    title: 'We keep it working',
    desc: 'Monitoring, model updates and changes as your business changes. You are not handed a config screen and wished luck.',
  },
];

// Named integrations rather than "integrates with anything", because the first
// question after "do you do my kind of business?" is "does it talk to the thing
// I already use?" — and the three below are the ones actually asked for.
const INTEGRATIONS = [
  'WhatsApp — confirmations, reminders and replies',
  'Your CRM — leads and call outcomes pushed as they happen',
  'Email — summaries and follow-ups sent off the call',
  'Anything else you run, over our REST API and webhooks',
];

const RUN_INCLUDES = [
  'Every minute spoken, metered per call',
  'Top up a balance — no monthly fee',
  'Alerts before the balance runs out',
  'Support and changes included',
];

const API_SCOPES = ['calls:read', 'calls:write', 'appointments:read', 'usage:read', 'wallet:read'];

export function Landing({
  authed,
  ratePerMinute,
}: {
  authed?: boolean;
  ratePerMinute?: number;
  // Still accepted (page.tsx passes it) but deliberately NOT shown: the volume
  // rate is agreed on the call, and quoting it here invited every visitor to
  // read the lower number as their number.
  scaleRatePerMinute?: number;
}) {
  // The rate comes from the database at request time so a change made in /admin
  // shows here, falling back to the code catalogue if the lookup failed — the
  // marketing page must never fail to render over a pricing query.
  const rate = ratePerMinute ?? RATE_PER_MINUTE_INR;

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse">
      <MarketingNav authed={authed} accent="#8b7fff" />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 pb-20 pt-16 lg:px-8 lg:pt-24">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-7">
            <p className="inline-flex items-center gap-2 rounded-full border border-border-inverse-strong px-3.5 py-1.5 text-eyebrow uppercase text-muted-inverse">
              <span className="h-1.5 w-1.5 rounded-full bg-primary-on-dark" />
              AI Automations Agency
            </p>
            <h1 className="h-display mt-6 text-[2.6rem] font-bold !leading-[1.03] tracking-tight text-ink-inverse sm:text-5xl lg:text-[3.85rem]">
              We build the automation.
              <br />
              <span className="text-primary-on-dark">We run it too.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-inverse-soft">
              Voice agents and back-office automations, built for one business at a time — then
              hosted, metered and supported by us. Deployed in our cloud, or inside yours.
            </p>
            <div className="mt-9 flex flex-wrap gap-3.5">
              <Link
                href="/contact"
                className="rounded-xl bg-primary-on-dark px-7 py-3.5 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
              >
                Book a call
              </Link>
              <Link
                href="#how-it-sounds"
                className="rounded-xl border border-border-inverse-strong px-7 py-3.5 text-[15px] font-medium text-ink-inverse transition-colors duration-fast hover:bg-surface-inverse"
              >
                Hear an agent
              </Link>
            </div>

            <dl className="mt-11 flex flex-wrap gap-9 border-t border-border-inverse pt-7">
              {[
                [String(LANGUAGES.length), `languages, ${INDIAN_LANGUAGE_COUNT} of them Indian`],
                [String(SOLUTIONS.length), 'industries we build for today'],
                ['2', 'ways to deploy — ours or yours'],
              ].map(([value, label]) => (
                <div key={label}>
                  <dt className="sr-only">{label}</dt>
                  <dd>
                    <span className="h-display block text-[1.6rem] font-semibold text-ink-inverse">{value}</span>
                    <span className="mt-1 block max-w-[15ch] text-[13px] leading-snug text-muted-inverse">
                      {label}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="lg:col-span-5">
            <CallDemo />
          </div>
        </div>
      </section>

      {/* ── Industries ───────────────────────────────────────────────────── */}
      <section id="solutions" className="scroll-mt-20 border-t border-border-inverse">
        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8">
          <Reveal>
            <div className="flex flex-wrap items-end gap-10">
              <div>
                <p className="eyebrow text-muted-inverse">Who we build for</p>
                <h2 className="h-display mt-3.5 text-3xl font-semibold tracking-tight text-ink-inverse sm:text-[2.5rem]">
                  Six industries, one platform underneath
                </h2>
              </div>
              <div className="flex-1" />
              <p className="max-w-sm text-[15px] leading-relaxed text-muted-inverse">
                Every build starts from a working template for that trade, then gets shaped around
                how you actually operate.
              </p>
            </div>
          </Reveal>

          <div className="mt-11 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {SOLUTIONS.map((s, i) => (
              <Reveal key={s.slug} delay={i * 40}>
                <Link
                  href={`/solutions/${s.slug}`}
                  className="group flex h-full flex-col gap-3 rounded-2xl border border-border-inverse bg-surface-inverse p-6 transition-colors duration-base ease-standard hover:bg-surface-inverse-2"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="grid h-[30px] w-[30px] place-items-center rounded-[9px]"
                      style={{ background: s.accent.soft }}
                    >
                      <span className="h-[9px] w-[9px] rounded-[3px]" style={{ background: s.accent.dark }} />
                    </span>
                    <h3 className="font-display text-[17px] font-semibold text-ink-inverse">{s.name}</h3>
                  </div>
                  <p className="text-sm leading-relaxed text-ink-inverse-soft">{s.cardBlurb}</p>
                  <div className="flex-1" />
                  <span
                    className="flex items-center gap-1.5 text-[13px] font-medium"
                    style={{ color: s.accent.dark }}
                  >
                    {s.cardMeta}
                    <ArrowRight className="h-3.5 w-3.5 transition-transform duration-base ease-standard group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── How a build works ────────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-20 border-t border-border-inverse bg-surface-inverse-2">
        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8">
          <Reveal>
            <p className="eyebrow text-muted-inverse">What a build includes</p>
            <h2 className="h-display mt-3.5 max-w-2xl text-3xl font-semibold tracking-tight text-ink-inverse sm:text-[2.5rem]">
              Not a subscription you configure. A system we deliver.
            </h2>
          </Reveal>

          <div className="mt-11 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {HOW.map((h, i) => (
              <Reveal key={h.step} delay={i * 40}>
                <div className="flex h-full flex-col gap-3 border-t-2 border-primary-on-dark pt-5">
                  <span className="font-display text-[13px] font-semibold text-primary-on-dark">{h.step}</span>
                  <h3 className="font-display text-[19px] font-semibold leading-snug text-ink-inverse">{h.title}</h3>
                  <p className="text-sm leading-relaxed text-ink-inverse-soft">{h.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Deployment ───────────────────────────────────────────────────── */}
      <section className="border-t border-border-inverse">
        <div className="mx-auto grid max-w-6xl gap-14 px-5 py-20 lg:grid-cols-2 lg:items-center lg:px-8">
          <Reveal>
            <p className="eyebrow text-muted-inverse">Where it runs</p>
            <h2 className="h-display mt-3.5 text-3xl font-semibold tracking-tight text-ink-inverse sm:text-[2.5rem]">
              Your cloud, or ours
            </h2>
            <p className="mt-5 max-w-md leading-relaxed text-ink-inverse-soft">
              Most clients run on our infrastructure and never think about it. Where data has to stay
              inside your own account — residency, procurement, an internal security review — we ship
              the same system as a pinned container into your cloud.
            </p>
            <p className="mt-4 max-w-md leading-relaxed text-ink-inverse-soft">
              Either way the usage meter, the wallet and the support line stay with us, so a
              deployment in your account is still one invoice and one number to call.
            </p>
          </Reveal>

          <Reveal delay={60}>
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border border-primary-on-dark bg-surface-inverse p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-display text-[17px] font-semibold text-ink-inverse">Hosted by us</h3>
                  <span className="rounded-full bg-primary-on-dark px-2.5 py-0.5 text-eyebrow uppercase text-bg-inverse">
                    Most clients
                  </span>
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-ink-inverse-soft">
                  Live in days. We patch it, monitor it and carry the pager. Nothing to provision on
                  your side.
                </p>
              </div>
              <div className="rounded-2xl border border-border-inverse bg-surface-inverse p-6">
                <h3 className="font-display text-[17px] font-semibold text-ink-inverse">In your cloud</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-ink-inverse-soft">
                  A versioned container into your AWS, GCP or Azure account. Your database, your
                  network, your data residency — our runtime and our updates.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" className="scroll-mt-20 border-t border-border-inverse bg-surface-inverse-2">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-12 lg:px-8">
          <Reveal className="lg:col-span-5">
            <p className="eyebrow text-muted-inverse">Pricing</p>
            <h2 className="h-display mt-3.5 text-3xl font-semibold tracking-tight text-ink-inverse sm:text-[2.5rem]">
              Minutes you top up, nothing monthly
            </h2>
            <p className="mt-5 leading-relaxed text-ink-inverse-soft">
              You keep a balance for what the agent runs, and top it up when it gets low. No seats,
              no tiers, and no monthly fee sitting there in a quiet month. What we build for you is
              scoped and quoted on the call.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-muted-inverse">
              Rates are agreed per client against the volume and the work — the numbers here are the
              starting point, not a table you get sorted into.
            </p>
          </Reveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:col-span-7">
            <Reveal>
              <div className="h-full rounded-[18px] border border-border-inverse bg-surface-inverse p-7">
                <h3 className="font-display text-[15px] font-semibold text-muted-inverse">
                  Custom integrations
                </h3>
                <p className="h-display mt-3.5 text-[2.35rem] font-bold tracking-tight text-ink-inverse">
                  Included
                </p>
                <p className="mt-1.5 text-[13px] text-muted-inverse">
                  built into what we scope with you
                </p>
                <ul className="mt-6 space-y-2.5">
                  {INTEGRATIONS.map((f) => (
                    <li key={f} className="flex gap-2.5 text-sm text-ink-inverse-soft">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary-on-dark" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>

            <Reveal delay={60}>
              <div className="h-full rounded-[18px] border border-primary-on-dark bg-surface-inverse p-7">
                <h3 className="font-display text-[15px] font-semibold text-primary-on-dark">The running</h3>
                <p className="mt-3.5 flex items-baseline gap-1.5">
                  <span className="text-[15px] text-muted-inverse">from</span>
                  <span className="h-display text-[2.35rem] font-bold tracking-tight text-ink-inverse">
                    ₹{rate}
                  </span>
                  <span className="text-[15px] text-muted-inverse">/ minute</span>
                </p>
                <p className="mt-1.5 text-[13px] text-muted-inverse">billed from your balance</p>
                <ul className="mt-6 space-y-2.5">
                  {RUN_INCLUDES.map((f) => (
                    <li key={f} className="flex gap-2.5 text-sm text-ink-inverse-soft">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary-on-dark" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Developers ───────────────────────────────────────────────────── */}
      <section className="border-t border-border-inverse">
        <div className="mx-auto grid max-w-6xl gap-14 px-5 py-20 lg:grid-cols-2 lg:items-center lg:px-8">
          <Reveal>
            <p className="eyebrow text-muted-inverse">For your developers</p>
            <h2 className="h-display mt-3.5 text-3xl font-semibold tracking-tight text-ink-inverse sm:text-[2.5rem]">
              Everything we run, behind a scoped API key
            </h2>
            <p className="mt-5 max-w-lg leading-relaxed text-ink-inverse-soft">
              Read calls and outcomes, place outbound calls, push records from the system you already
              run, and check your own usage. Keys are scoped per endpoint, and signed webhooks tell
              you the moment a call ends.
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5">
              {API_SCOPES.map((s) => (
                <code
                  key={s}
                  className="rounded-md border border-border-inverse bg-surface-inverse px-2.5 py-1.5 font-mono text-xs text-ink-inverse-soft"
                >
                  {s}
                </code>
              ))}
            </div>
            <Link
              href="/docs/developer-guide"
              className="mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-primary-on-dark hover:opacity-80"
            >
              Read the API reference
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Reveal>

          <Reveal delay={60}>
            <div className="overflow-hidden rounded-2xl border border-border-inverse bg-surface-inverse-2">
              <div className="flex items-center gap-2 border-b border-border-inverse px-4.5 py-3.5">
                <span className="h-2.5 w-2.5 rounded-full bg-border-inverse-strong" />
                <span className="h-2.5 w-2.5 rounded-full bg-border-inverse-strong" />
                <span className="h-2.5 w-2.5 rounded-full bg-border-inverse-strong" />
                <span className="ml-2 text-xs text-muted-inverse">place an outbound call</span>
              </div>
              <pre className="overflow-x-auto p-6 font-mono text-[12.5px] leading-[1.75] text-ink-inverse-soft">
{`$ curl -X POST https://vaaniyantra.com/api/v1/calls \\
    -H "Authorization: Bearer vy_live_..." \\
    -H "Idempotency-Key: visit-4821" \\
    -d '{"agentId":"ag_7f2","to":"+919876543210"}'

{
  "id": "call_9d41",
  "status": "QUEUED",
  "direction": "OUTBOUND"
}`}
              </pre>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Close ────────────────────────────────────────────────────────── */}
      <section className="border-t border-border-inverse bg-surface-inverse-2">
        <div className="mx-auto max-w-6xl px-5 py-24 text-center lg:px-8">
          <Reveal>
            <h2 className="h-display mx-auto max-w-3xl text-[2.35rem] font-bold !leading-[1.08] tracking-tight text-ink-inverse sm:text-[2.9rem]">
              Tell us what keeps going unanswered
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-[17px] leading-relaxed text-ink-inverse-soft">
              A 30-minute call. We will tell you whether this is worth building for you, and roughly
              what it costs, before you commit to anything.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3.5">
              <Link
                href="/contact"
                className="rounded-xl bg-primary-on-dark px-8 py-4 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
              >
                Book a call
              </Link>
              <Link
                href="/solutions"
                className="rounded-xl border border-border-inverse-strong px-8 py-4 text-[15px] font-medium text-ink-inverse transition-colors duration-fast hover:bg-surface-inverse"
              >
                See what we build
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
