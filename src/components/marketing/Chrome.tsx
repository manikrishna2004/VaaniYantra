import Link from 'next/link';
import { SOLUTIONS } from '@/lib/verticals/solutions';

/**
 * The nav and footer every public page shares.
 *
 * Pulled out of Landing.tsx when the site stopped being one page. Six solution
 * pages plus the landing page is seven places a nav link could quietly differ,
 * and the version that differs is always the one a customer is looking at.
 *
 * Server-rendered on purpose: the nav carries the site's internal linking, and
 * a client component would keep it out of the HTML search engines read.
 *
 * These render on the DARK marketing scale (`bg-inverse` and friends). The
 * signed-in app has its own chrome in Sidebar.tsx and shares nothing with this.
 */

export function MarketingNav({ authed, accent }: { authed?: boolean; accent?: string }) {
  // The wordmark's bars take the page's accent, so a solutions page is visibly
  // its own industry from the first element on the page.
  const mark = accent ?? 'var(--accent-vertical)';

  return (
    <header className="border-b border-border-inverse">
      <nav className="mx-auto flex max-w-6xl items-center gap-8 px-5 py-4 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={mark} strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4" />
          </svg>
          <span className="font-display text-base font-bold tracking-tight text-ink-inverse">VaaniYantra</span>
        </Link>

        <div className="hidden items-center gap-6 text-sm text-muted-inverse md:flex">
          <Link href="/solutions" className="transition-colors duration-fast hover:text-ink-inverse">Solutions</Link>
          <Link href="/#how" className="transition-colors duration-fast hover:text-ink-inverse">How it works</Link>
          <Link href="/#pricing" className="transition-colors duration-fast hover:text-ink-inverse">Pricing</Link>
          {/* The kit is a different offer from the service the rest of this nav
              sells — a one-off download, for someone who wants to build it
              themselves. Named "Starter Kit" rather than a price, so it reads
              as a product and not as a discount on the agency work. */}
          <Link href="/kit" className="transition-colors duration-fast hover:text-ink-inverse">Starter Kit</Link>
          <Link href="/docs" className="transition-colors duration-fast hover:text-ink-inverse">Developers</Link>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-4">
          <Link
            href={authed ? '/dashboard' : '/sign-in'}
            className="hidden text-sm text-muted-inverse transition-colors duration-fast hover:text-ink-inverse sm:block"
          >
            {authed ? 'Dashboard' : 'Sign in'}
          </Link>
          <Link
            href="/contact"
            className="rounded-xl px-4 py-2.5 text-sm font-semibold transition-opacity duration-fast hover:opacity-90"
            style={{ background: mark, color: 'var(--accent-vertical-on)' }}
          >
            Book a call
          </Link>
        </div>
      </nav>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border-inverse">
      <div className="mx-auto max-w-6xl px-5 py-10 lg:px-8">
        <div className="flex flex-wrap gap-8">
          <div className="min-w-[200px] flex-1">
            <div className="font-display text-base font-bold tracking-tight text-ink-inverse">VaaniYantra</div>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-inverse">
              An AI automations agency. We build the automation, and we run it.
            </p>
          </div>

          <nav aria-label="Solutions" className="min-w-[160px]">
            <h2 className="eyebrow text-muted-inverse">Solutions</h2>
            <ul className="mt-3 space-y-2">
              {SOLUTIONS.map((s) => (
                <li key={s.slug}>
                  <Link
                    href={`/solutions/${s.slug}`}
                    className="text-sm text-muted-inverse transition-colors duration-fast hover:text-ink-inverse"
                  >
                    {s.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Company" className="min-w-[140px]">
            <h2 className="eyebrow text-muted-inverse">Company</h2>
            <ul className="mt-3 space-y-2">
              {[
                ['/contact', 'Contact'],
                ['/kit', 'Starter Kit'],
                ['/docs', 'Documentation'],
                ['/security', 'Security'],
                ['/status', 'Status'],
              ].map(([href, label]) => (
                <li key={href}>
                  <Link href={href} className="text-sm text-muted-inverse transition-colors duration-fast hover:text-ink-inverse">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Legal" className="min-w-[140px]">
            <h2 className="eyebrow text-muted-inverse">Legal</h2>
            <ul className="mt-3 space-y-2">
              {[
                ['/privacy', 'Privacy'],
                ['/terms', 'Terms'],
                ['/dpa', 'DPA'],
                ['/subprocessors', 'Subprocessors'],
                ['/refunds', 'Refunds'],
              ].map(([href, label]) => (
                <li key={href}>
                  <Link href={href} className="text-sm text-muted-inverse transition-colors duration-fast hover:text-ink-inverse">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <p className="mt-10 border-t border-border-inverse pt-6 text-xs text-muted-inverse">
          © {new Date().getFullYear()} VaaniYantra. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
