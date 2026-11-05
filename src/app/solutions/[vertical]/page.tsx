import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { Check } from 'lucide-react';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { solutionBySlug, solutionSlugs, otherSolutions } from '@/lib/verticals/solutions';

// One page, six industries. Everything that differs between them lives in
// src/lib/verticals/solutions.ts — this file is only the layout.
//
// Replaces the hand-built /ai-receptionist-for-clinics and /for-dental-clinics,
// which had already begun to drift apart in copy and CTA wording. Both old
// paths permanently redirect here (next.config.js) because they carry the only
// search ranking this domain has.

export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return solutionSlugs().map((vertical) => ({ vertical }));
}

export async function generateMetadata(props: {
  params: Promise<{ vertical: string }>;
}): Promise<Metadata> {
  const { vertical } = await props.params;
  const s = solutionBySlug(vertical);
  if (!s) return {};
  const url = `https://vaaniyantra.com/solutions/${s.slug}`;
  return {
    title: s.title,
    description: s.metaDescription,
    alternates: { canonical: url },
    openGraph: { title: s.title, description: s.metaDescription, url, type: 'website' },
  };
}

export default async function SolutionPage(props: { params: Promise<{ vertical: string }> }) {
  const { vertical } = await props.params;
  const s = solutionBySlug(vertical);
  if (!s) notFound();

  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);
  const others = otherSolutions(s.slug);

  // The industry's colour, handed to the whole subtree as a custom property so
  // no component in here needs to know which vertical it is rendering. `-on` is
  // the readable ink for text sitting on the accent; it cannot be derived in
  // CSS, so the content table supplies it.
  const accentVars = {
    '--accent-vertical': s.accent.dark,
    '--accent-vertical-on': s.accent.on,
    '--accent-vertical-soft': s.accent.soft,
  } as React.CSSProperties;

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse" style={accentVars}>
      <MarketingNav authed={authed} />

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pb-16 pt-12 lg:px-8">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-inverse">
          <Link href="/solutions" className="transition-colors duration-fast hover:text-ink-inverse">
            Solutions
          </Link>
          <span className="px-2 text-border-inverse-strong">/</span>
          <span style={{ color: 'var(--accent-vertical)' }}>{s.name}</span>
        </nav>

        <div className="mt-7 grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h1 className="h-display text-4xl font-bold !leading-[1.05] tracking-tight text-ink-inverse sm:text-5xl lg:text-[3.4rem]">
              {s.headline.lead}{' '}
              <span style={{ color: 'var(--accent-vertical)' }}>{s.headline.accented}</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-inverse-soft">{s.lede}</p>
            <div className="mt-8 flex flex-wrap gap-3.5">
              <Link
                href="/contact"
                className="rounded-xl px-7 py-3.5 text-[15px] font-semibold transition-opacity duration-fast hover:opacity-90"
                style={{ background: 'var(--accent-vertical)', color: 'var(--accent-vertical-on)' }}
              >
                Book a call
              </Link>
              <Link
                href="/#how-it-sounds"
                className="rounded-xl border border-border-inverse-strong px-7 py-3.5 text-[15px] font-medium text-ink-inverse transition-colors duration-fast hover:bg-surface-inverse"
              >
                Hear an agent
              </Link>
            </div>
          </div>

          {/* What it captures */}
          <div className="lg:col-span-5">
            <div className="rounded-[18px] border border-border-inverse bg-surface-inverse p-6">
              <h2 className="eyebrow text-muted-inverse">What it captures on every call</h2>
              <ul className="mt-4 space-y-2.5">
                {s.captures.map((c) => (
                  <li
                    key={c.label}
                    className="flex items-center gap-3 rounded-[10px] border border-border-inverse bg-surface-inverse-2 px-3.5 py-3"
                  >
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-full"
                      style={{ background: 'var(--accent-vertical)' }}
                    />
                    <span className="flex-1 text-sm text-ink-inverse-soft">{c.label}</span>
                    <span className="shrink-0 text-xs text-muted-inverse">{c.note}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-[13px] leading-relaxed text-muted-inverse">
                Delivered the moment the call ends, with the recording and a one-line summary attached.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="border-t border-border-inverse">
        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8">
          <h2 className="h-display max-w-2xl text-3xl font-semibold tracking-tight text-ink-inverse sm:text-[2.35rem]">
            Built for how this actually runs
          </h2>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            {s.features.map((f) => (
              <div
                key={f.title}
                className="flex items-start gap-4 rounded-2xl border border-border-inverse bg-surface-inverse p-6"
              >
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                  style={{ background: 'var(--accent-vertical-soft)' }}
                >
                  <Check className="h-4 w-4" style={{ color: 'var(--accent-vertical)' }} />
                </span>
                <div>
                  <h3 className="font-display text-[17px] font-semibold text-ink-inverse">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-inverse-soft">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The other five */}
      <section className="border-t border-border-inverse bg-surface-inverse-2">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:px-8">
          <h2 className="eyebrow text-muted-inverse">We also build for</h2>
          <div className="mt-5 flex flex-wrap gap-3">
            {others.map((o) => (
              <Link
                key={o.slug}
                href={`/solutions/${o.slug}`}
                className="rounded-full border border-border-inverse-strong px-5 py-2.5 text-sm text-ink-inverse-soft transition-colors duration-fast hover:border-transparent hover:bg-surface-inverse hover:text-ink-inverse"
              >
                {o.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border-inverse">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-10 px-5 py-20 lg:px-8">
          <div className="flex-1">
            <h2 className="h-display max-w-xl text-3xl font-bold tracking-tight text-ink-inverse sm:text-[2.35rem]">
              {s.cta.headline}
            </h2>
            <p className="mt-4 max-w-lg leading-relaxed text-ink-inverse-soft">{s.cta.sub}</p>
          </div>
          <Link
            href="/contact"
            className="shrink-0 rounded-xl px-8 py-4 text-[15px] font-semibold transition-opacity duration-fast hover:opacity-90"
            style={{ background: 'var(--accent-vertical)', color: 'var(--accent-vertical-on)' }}
          >
            Book a call
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
