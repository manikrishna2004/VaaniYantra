import Link from 'next/link';
import { cookies } from 'next/headers';
import { MarketingNav, MarketingFooter } from '@/components/marketing/Chrome';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { prisma } from '@/lib/db';
import { getCashfreeConfig, getOrder } from '@/lib/cashfree';
import { isKitOrderId, markPaid, markFailed } from '@/lib/kit/purchase';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your download' };

/**
 * Where Cashfree sends the buyer back.
 *
 * Does not trust the redirect. The browser arriving here proves nothing about
 * whether money moved — anyone can open this URL with any order id — so the
 * order is re-read from Cashfree and only its answer unlocks the file.
 *
 * It also cannot wait for the webhook. The redirect regularly beats the
 * webhook, and a buyer who has just paid will not accept "check your email".
 * So this settles the order itself, using the same idempotent markPaid the
 * webhook uses; whichever arrives first wins and the second is a no-op.
 */

async function resolve(orderId: string | undefined) {
  if (!orderId || !isKitOrderId(orderId)) return { state: 'unknown' as const };

  const row = await prisma.kitOrder.findUnique({ where: { orderId } });
  if (!row) return { state: 'unknown' as const };

  if (row.status === 'PAID' && row.downloadToken) {
    return { state: 'paid' as const, token: row.downloadToken, email: row.email };
  }

  // Not settled in our records yet — ask the gateway directly.
  try {
    const cfg = await getCashfreeConfig();
    if (!cfg.secretKey) return { state: 'pending' as const, email: row.email };

    const order = await getOrder(cfg, orderId);
    const status = String(order?.order_status ?? '').toUpperCase();

    if (status === 'PAID') {
      // No payment id here: the order endpoint returns cf_order_id, which is not
      // one. The webhook records the real cf_payment_id when it arrives.
      const updated = await markPaid(orderId, null);
      if (updated?.downloadToken) {
        return { state: 'paid' as const, token: updated.downloadToken, email: updated.email };
      }
    }
    if (status === 'EXPIRED' || status === 'TERMINATED') {
      await markFailed(orderId);
      return { state: 'failed' as const, email: row.email };
    }
  } catch (err) {
    // A gateway hiccup is not a failed payment. Show "confirming" and let them
    // refresh — the webhook will settle it regardless.
    console.error('[kit] could not re-read order', orderId, err);
  }

  return { state: 'pending' as const, email: row.email };
}

export default async function ThanksPage(props: {
  searchParams: Promise<{ order_id?: string }>;
}) {
  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);
  const { order_id: orderId } = await props.searchParams;
  const result = await resolve(orderId);

  return (
    <div className="min-h-screen bg-bg-inverse text-ink-inverse">
      <MarketingNav authed={authed} accent="#8b7fff" />

      <section className="mx-auto max-w-xl px-5 py-16 text-center lg:py-24">
        {result.state === 'paid' && (
          <>
            <h1 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              Paid. Here is your kit.
            </h1>
            <p className="mt-4 text-ink-inverse-soft">
              We have also emailed this link to{' '}
              <span className="text-ink-inverse">{result.email}</span>, so you can get to it again
              later.
            </p>

            <a
              href={`/api/kit/download?token=${encodeURIComponent(result.token)}`}
              className="mt-9 inline-block rounded-xl bg-primary-on-dark px-10 py-4 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
            >
              Download the kit
            </a>

            <div className="mt-12 rounded-2xl border border-border-inverse bg-surface-inverse p-6 text-left">
              <h2 className="font-display text-lg font-semibold text-ink-inverse">
                What to do next
              </h2>
              <ol className="mt-4 space-y-3 text-sm text-ink-inverse-soft">
                <li>
                  <span className="text-ink-inverse">1.</span> Unzip it, then run{' '}
                  <code className="rounded bg-surface-inverse-2 px-1.5 py-0.5 text-xs">npm install</code>{' '}
                  and{' '}
                  <code className="rounded bg-surface-inverse-2 px-1.5 py-0.5 text-xs">npm start</code>.
                </li>
                <li>
                  <span className="text-ink-inverse">2.</span> Open{' '}
                  <code className="rounded bg-surface-inverse-2 px-1.5 py-0.5 text-xs">
                    http://localhost:8080/setup
                  </code>{' '}
                  in your browser.
                </li>
                <li>
                  <span className="text-ink-inverse">3.</span> Work through the six steps. Each one has
                  instructions built in and a Test button that checks the credential really works.
                </li>
              </ol>
              <p className="mt-5 text-xs text-muted-inverse">
                The link works for 7 days and up to 5 downloads. Lost it? Reply to your receipt and we
                will send a new one.
              </p>
            </div>
          </>
        )}

        {result.state === 'pending' && (
          <>
            <h1 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              Confirming your payment
            </h1>
            <p className="mt-4 text-ink-inverse-soft">
              The bank has not confirmed it to us yet. This usually takes a few seconds — refresh this
              page in a moment.
            </p>
            <p className="mt-3 text-sm text-muted-inverse">
              If money has left your account, the download link will be emailed to{' '}
              <span className="text-ink-inverse-soft">{result.email}</span> as soon as it clears. You
              do not need to pay again.
            </p>
          </>
        )}

        {result.state === 'failed' && (
          <>
            <h1 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              That payment did not go through
            </h1>
            <p className="mt-4 text-ink-inverse-soft">
              Nothing has been charged. You can try again whenever you like.
            </p>
            <Link
              href="/kit/buy"
              className="mt-8 inline-block rounded-xl bg-primary-on-dark px-8 py-3.5 text-[15px] font-semibold text-bg-inverse transition-opacity duration-fast hover:opacity-90"
            >
              Try again
            </Link>
          </>
        )}

        {result.state === 'unknown' && (
          <>
            <h1 className="h-display text-3xl font-semibold text-ink-inverse sm:text-4xl">
              We cannot find that order
            </h1>
            <p className="mt-4 text-ink-inverse-soft">
              The link may be incomplete. If you have been charged, reply to your receipt and we will
              sort it out straight away.
            </p>
            <Link
              href="/kit"
              className="mt-8 inline-block rounded-xl border border-border-inverse-strong px-8 py-3.5 text-[15px] font-semibold text-ink-inverse transition-colors duration-fast hover:border-primary-on-dark"
            >
              Back to the kit
            </Link>
          </>
        )}
      </section>

      <MarketingFooter />
    </div>
  );
}
