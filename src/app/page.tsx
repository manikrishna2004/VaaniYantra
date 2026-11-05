import { cookies } from 'next/headers';
import { Landing } from '@/components/Landing';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';
import { getEffectivePlan } from '@/lib/billing/catalogue';

// Public marketing landing page. Logged-in visitors see a "Dashboard" CTA
// instead of "Contact us".
//
// Checks the token's expiry rather than merely that a cookie exists: the cookie
// outlives the ~1h token by design, so presence alone showed "Dashboard" to
// visitors whose session had lapsed, and the click bounced them to sign-in.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const authed = isTokenLive((await cookies()).get(SESSION_COOKIE)?.value);
  // Read the two live rates at request time so a rate changed in /admin shows
  // here too. Falls back to the code catalogue if the database is unreachable —
  // the marketing page must never fail to render over a pricing lookup.
  const rates = await Promise.all([getEffectivePlan('standard'), getEffectivePlan('scale')])
    .then(([standard, scale]) => ({
      ratePerMinute: standard.pricePerMinute,
      scaleRatePerMinute: scale.pricePerMinute,
    }))
    .catch(() => ({ ratePerMinute: undefined, scaleRatePerMinute: undefined }));
  return <Landing authed={authed} {...rates} />;
}
