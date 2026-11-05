import Link from 'next/link';
import { cookies } from 'next/headers';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { checkDownloadToken } from '@/lib/kit/purchase';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Download the Starter Kit', robots: { index: false } };

/**
 * What the link in the receipt email opens.
 *
 * The file itself is served by /api/kit/download. This page exists so a buyer
 * whose link has expired reads a sentence telling them what to do, instead of
 * a raw JSON error — which is what a bare API link gives you, and which
 * generates a support email every time.
 */

const PROBLEMS = {
  unknown: {
    title: 'That link is not valid',
    body: 'It may have been cut short by an email client. Try copying the whole link from your receipt, or reply to it and we will send a fresh one.',
  },
  unpaid: {
    title: 'That order has not been paid',
    body: 'If you believe you have paid, reply to your receipt and we will look into it straight away.',
  },
  expired: {
    title: 'That link has expired',
    body: 'Download links last 7 days. Reply to your receipt and we will send you a new one — your purchase does not expire.',
  },
  exhausted: {
    title: 'That link has been used up',
    body: 'Each link allows 5 downloads. Reply to your receipt and we will issue another — there is no extra charge.',
  },
} as const;

export default async function DownloadPage(props: {
  searchParams: Promise<{ token?: string }>;
}) {
  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);
  const { token } = await props.searchParams;
  const check = await checkDownloadToken(token);

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse">
      <MarketingNav authed={authed} accent="#8b7fff" />

      <section className="mx-auto max-w-xl px-5 py-16 text-center lg:py-24">
        {check.ok ? (
          <>
            <h1 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              Your Starter Kit
            </h1>
            <p className="mt-4 text-ink-inverse-soft">
              {check.order.maxDownloads - check.order.downloadCount} download
              {check.order.maxDownloads - check.order.downloadCount === 1 ? '' : 's'} left on this
              link.
            </p>
            <a
              href={`/api/kit/download?token=${encodeURIComponent(token ?? '')}`}
              className="mt-9 inline-block rounded-xl bg-primary-on-dark px-10 py-4 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
            >
              Download the kit
            </a>
            <p className="mt-6 text-sm text-muted-inverse">
              Unzip it, run <code className="rounded bg-surface-inverse-2 px-1.5 py-0.5 text-xs">npm install</code>{' '}
              then <code className="rounded bg-surface-inverse-2 px-1.5 py-0.5 text-xs">npm start</code>, and open{' '}
              <code className="rounded bg-surface-inverse-2 px-1.5 py-0.5 text-xs">localhost:8080/setup</code>.
            </p>
          </>
        ) : (
          <>
            <h1 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              {PROBLEMS[check.reason].title}
            </h1>
            <p className="mt-4 text-ink-inverse-soft">{PROBLEMS[check.reason].body}</p>
            <Link
              href="/contact"
              className="mt-8 inline-block rounded-xl border border-border-inverse-strong px-8 py-3.5 text-[15px] font-semibold text-ink-inverse transition-colors duration-fast hover:border-primary-on-dark"
            >
              Get in touch
            </Link>
          </>
        )}
      </section>

      <MarketingFooter />
    </div>
  );
}
