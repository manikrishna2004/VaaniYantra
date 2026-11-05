import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revokePortalLogin } from '@/lib/portal/contacts';
import { PORTAL_COOKIE, portalCookieOptions } from '@/lib/portal/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Sign out — useful on a shared or borrowed device, which in a clinic waiting
// room is not a hypothetical.
//
// The POST that used to live here exchanged a `?k=` bearer token from the
// patient's link for a cookie. Patients now sign in with their phone number and
// a one-time code, so that exchange is gone: see ../otp/start and ../otp/verify.
export async function DELETE() {
  const jar = await cookies();
  // Revoke the session server-side too, not just the cookie: a token copied off
  // the device would otherwise keep working until it expired.
  await revokePortalLogin(jar.get(PORTAL_COOKIE)?.value);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(PORTAL_COOKIE, '', { ...portalCookieOptions(), maxAge: 0 });
  return res;
}
