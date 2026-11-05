import Link from 'next/link';
import { Check } from 'lucide-react';
import { cookies } from 'next/headers';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { Reveal } from '@/components/landing/motion';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { KIT_PRICE_INR } from '@/lib/kit/purchase';
import { CallAnimation } from '@/components/kit/CallAnimation';

// The Starter Kit sales page — a one-off digital download, not the agency
// service the rest of the marketing site sells.
//
// WHO THIS IS FOR, and why it reads nothing like the homepage: the homepage
// addresses an owner who wants their phone answered and does not care how. This
// page addresses someone who wants to BUILD it — a developer, a freelancer, an
// agency owner, or the technical person at a clinic. They arrive from a
// 30-second Instagram reel, on a phone, knowing only that they saw a phone call
// get answered by software.
//
// So the page has one job: convince them in one screenful that the thing is
// real and that ₹299 is not a trick, then get out of the way.
//
// ⚠ Inherits the homepage's rule: NO INVENTED SOCIAL PROOF. No sales counts, no
// testimonials, no "join N builders". We have not sold one yet. The proof here
// is specificity — naming the actual files, the actual failure modes and the
// actual per-minute cost is what a technical buyer reads as credible.
//
// ⚠ Sold in INR only, through our own Cashfree account. That is a deliberate
// narrowing: Cashfree cannot charge a card issued outside India (see
// internationalEnabled in src/lib/cashfree.ts), so a dollar price would send
// overseas buyers to a page that declines them. One currency, one price.
//
// Both buttons go to /kit/buy rather than straight to a gateway, because the
// email is collected first — it is the buyer's only identity, and the only way
// to re-send a download link later.

export const metadata = {
  title: 'Voice Agent Starter Kit',
  description:
    'Build a phone number that answers itself, books into a real calendar and confirms on WhatsApp. Complete source and setup guide.',
};

const INCLUDED = [
  {
    title: 'A setup screen, not a config file',
    body: 'Six steps in your browser. Paste each credential, press Test, and it makes a real call to that service and tells you exactly what is wrong — not "invalid credentials", but which of the three things it could be.',
  },
  {
    title: 'Twilio or Exotel',
    body: 'Pick one in a dropdown and the fields change to match. Twilio worldwide, Exotel for Indian numbers. They speak different audio formats on the wire; the kit handles both and never mentions it again.',
  },
  {
    title: 'The complete server',
    body: 'Every line of it, commented. The answer webhook, the audio bridge, the Gemini Live conversation, the tool layer. No build step and three dependencies.',
  },
  {
    title: 'The prompt pack',
    body: 'A plain-English prompt file re-read on every call — change a line, run the simulator, hear the difference. Finished versions included for a dental clinic, a salon and an estate agency.',
  },
  {
    title: 'WhatsApp and Calendar, connected',
    body: 'One button connects Google Calendar, so you never touch the OAuth playground. WhatsApp confirmations come with the explanation of why they must be an approved template — the thing that silently breaks most first attempts.',
  },
  {
    title: 'A guide for when it breaks',
    body: 'Nine sections covering every key, every screen you click through, and the specific place each service goes wrong. Written to be followed, not skimmed.',
  },
];

const NOT_INCLUDED = [
  'Phone minutes, API credit or hosting — you connect your own accounts and pay those providers directly. Google’s realtime API needs billing enabled; the kit tells you plainly if it is not.',
  'A hosted service. It runs on your machine, and we never see your keys or your calls.',
  'Support beyond the guide, at this price.',
];

export default async function KitPage() {
  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse">
      <MarketingNav authed={authed} accent="#8b7fff" />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 pb-16 pt-14 lg:px-8 lg:pb-24 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-[1.15fr_1fr] lg:items-start lg:gap-16">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary-on-dark">
              Starter kit · one-off purchase
            </p>
            <h1 className="h-display mt-3 text-4xl font-semibold leading-[1.1] text-ink-inverse sm:text-5xl">
              A phone number that answers itself.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-inverse-soft">
              It picks up, holds a real conversation, lets the caller interrupt it, checks an actual
              diary before offering a time, books the appointment and sends a WhatsApp confirmation
              before they have put the phone down.
            </p>
            <p className="mt-4 max-w-xl text-ink-inverse-soft">
              The whole workflow, running on your own machine. You plug in your own accounts
              through a setup screen — no config files — and it is yours. There is nothing to
              subscribe to and nothing phones home.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/kit/buy"
                className="rounded-xl bg-primary-on-dark px-8 py-4 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
              >
                Get the kit — ₹{KIT_PRICE_INR}
              </Link>
              <span className="text-sm text-muted-inverse">One-off · instant download</span>
            </div>
          </Reveal>

          {/* A call being answered, shown rather than diagrammed — the buyer
              arrives from a reel having just seen one, and this is the same
              moment on the page. */}
          <Reveal delay={100}>
            <CallAnimation />
          </Reveal>
        </div>
      </section>

      {/* ── What you get ─────────────────────────────────────────────────── */}
      <section className="border-t border-border-inverse bg-surface-inverse-2">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:px-8 lg:py-20">
          <Reveal className="max-w-2xl">
            <h2 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">What is in it</h2>
            <p className="mt-3 text-ink-inverse-soft">
              Everything below is in the download. Nothing is gated, upsold or reserved for a higher
              tier — there is no higher tier.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2">
            {INCLUDED.map((item, i) => (
              <Reveal key={item.title} delay={i * 60}>
                <h3 className="font-display text-lg font-semibold text-ink-inverse">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-inverse-soft">{item.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Honesty section ──────────────────────────────────────────────── */}
      <section className="border-t border-border-inverse">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:px-8 lg:py-20">
          <div className="max-w-3xl">
            <Reveal>
              <h2 className="h-display text-2xl font-semibold text-ink-inverse sm:text-3xl">What it is not</h2>
              <p className="mt-3 text-ink-inverse-soft">
                Worth being plain about, so nobody buys the wrong thing.
              </p>
              <ul className="mt-7 space-y-4 text-sm text-ink-inverse-soft">
                {NOT_INCLUDED.map((line) => (
                  <li key={line} className="flex gap-3">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-inverse" />
                    {line}
                  </li>
                ))}
              </ul>
              <div className="mt-8 rounded-xl border border-border-inverse bg-surface-inverse p-5">
                <p className="text-sm text-ink-inverse-soft">
                  You will need to be comfortable running{' '}
                  <code className="font-mono text-xs text-ink-inverse">npm install</code> once, and
                  opening accounts with Twilio or Exotel, Google and Meta to get the keys. The rest
                  is a setup screen. If that is not you, the kit is the wrong shape —{' '}
                  <Link href="/contact" className="underline hover:text-ink-inverse">
                    we also just build these
                  </Link>
                  .
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Licence + buy ────────────────────────────────────────────────── */}
      <section className="border-t border-border-inverse bg-surface-inverse-2">
        <div className="mx-auto max-w-3xl px-5 py-16 text-center lg:px-8 lg:py-24">
          <Reveal>
            <h2 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              ₹{KIT_PRICE_INR}, once
            </h2>
            <p className="mt-3 text-ink-inverse-soft">
              No subscription, no per-minute fee to us, nothing to cancel.
            </p>

            <ul className="mx-auto mt-9 max-w-md space-y-3 text-left text-sm">
              {[
                'Run it for your own business, on any number of lines',
                'Build it for a client as paid work, and keep it running for them',
                'Modify anything — it is yours',
                'Instant download — the link is emailed to you as well',
              ].map((line) => (
                <li key={line} className="flex gap-3 text-ink-inverse-soft">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary-on-dark" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>

            <Link
              href="/kit/buy"
              className="mt-10 inline-block rounded-xl bg-primary-on-dark px-10 py-4 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
            >
              Get the kit
            </Link>
            <p className="mt-5 text-xs text-muted-inverse">
              The one thing you may not do is resell or redistribute the kit itself.
            </p>
          </Reveal>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
