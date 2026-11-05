import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { ArrowRight } from 'lucide-react';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { SOLUTIONS } from '@/lib/verticals/solutions';

// The index the six vertical pages hang off. Exists so "Solutions" in the nav
// goes somewhere rather than opening a dropdown that search engines cannot
// follow — this page is what internally links all six.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Solutions',
  description:
    'AI voice agents and automations, built and run for healthcare, real estate, restaurants, education, interior design, and lead screening for any business.',
  alternates: { canonical: 'https://vaaniyantra.com/solutions' },
};

export default async function SolutionsIndex() {
  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse">
      <MarketingNav authed={authed} />

      <section className="mx-auto max-w-6xl px-5 pb-14 pt-16 lg:px-8">
        <h1 className="h-display max-w-3xl text-4xl font-bold !leading-[1.06] tracking-tight text-ink-inverse sm:text-5xl">
          Six industries, one platform underneath
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-inverse-soft">
          Every build starts from a working template for that trade, then gets shaped around how you
          actually operate. Pick the one closest to your business.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-24 lg:px-8">
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {SOLUTIONS.map((s) => (
            <Link
              key={s.slug}
              href={`/solutions/${s.slug}`}
              className="group flex flex-col gap-3 rounded-2xl border border-border-inverse bg-surface-inverse p-6 transition-colors duration-base ease-standard hover:bg-surface-inverse-2"
              style={{ '--accent-vertical': s.accent.dark } as React.CSSProperties}
            >
              <div className="flex items-center gap-3">
                <span
                  className="grid h-[30px] w-[30px] place-items-center rounded-[9px]"
                  style={{ background: s.accent.soft }}
                >
                  <span
                    className="h-[9px] w-[9px] rounded-[3px]"
                    style={{ background: s.accent.dark }}
                  />
                </span>
                <h2 className="font-display text-[17px] font-semibold text-ink-inverse">{s.name}</h2>
              </div>
              <p className="text-sm leading-relaxed text-ink-inverse-soft">{s.cardBlurb}</p>
              <div className="flex-1" />
              <div
                className="flex items-center gap-1.5 text-[13px] font-medium"
                style={{ color: s.accent.dark }}
              >
                {s.cardMeta}
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-base ease-standard group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
