import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, isTokenLive } from '@/lib/auth/session-cookie';

// Middleware runs on the Edge runtime, where firebase-admin can't verify the
// cookie. So we only gate on cookie *presence* here (cheap); server components
// and API routes do the real verification via getSessionUser().
// Every route under the (app) group. Anything missing here still gets caught
// server-side by requireWorkspace(), but redirects to a BARE /sign-in — losing
// the destination, so the user lands on the dashboard instead of the deep link
// they followed. Keep this list in sync when adding an app route.
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/agents',
  '/calls',
  '/live',
  '/appointments',
  '/calendar',
  // A doctor's own profile, hours and calendar.
  '/my-practice',
  // Merged into /appointments, but the route still exists as a redirect — it
  // has to stay listed so an old bookmark survives sign-in with its ?next=.
  '/updates',
  '/reports',
  '/knowledge',
  '/chatbot',
  '/patients',
  '/connectors',
  '/numbers',
  '/team',
  '/settings',
  '/admin',
  '/checkout',
  // Lives outside the (app) group so the sidebar doesn't print, but it is still
  // an authenticated page — without it here, opening an emailed invoice link
  // while signed out drops the ?next= and lands the user on /dashboard after
  // sign-in, with no way back to the invoice they clicked.
  '/invoices',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = isTokenLive(req.cookies.get(SESSION_COOKIE)?.value);
  const onProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );

  if (onProtected && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // Deliberately NOT redirecting /sign-in → /dashboard on cookie presence.
  //
  // isTokenLive() only decodes `exp`; on the Edge runtime we cannot verify the
  // signature. So a cookie that merely *looks* live — tampered, revoked, or
  // issued by a previous Firebase project — used to bounce /sign-in to
  // /dashboard, where real verification failed and sent it back to /sign-in.
  // That is an unbreakable redirect loop, and because the user can never reach
  // the sign-in page, there is no way out of it.
  //
  // The redirect an authenticated user should get lives in the /sign-in page's
  // server component instead, where getSessionUser() can verify the signature
  // for real and a bad cookie falls through to the form rather than looping.
  return NextResponse.next();
}

// Run on all routes except API, Next internals, and static assets.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
