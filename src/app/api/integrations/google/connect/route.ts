import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { apiContext, deny } from '@/lib/auth/api';
import { buildAuthUrl, googleOAuthConfigured } from '@/lib/google-oauth';
import { parseTarget, encodeState } from '@/lib/google-target';
import { isSuperAdmin } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Kick off the Google OAuth consent flow. Sets a short-lived state cookie for
// CSRF protection and redirects the browser to Google.
//
// ?target=org connects the CLINIC's shared calendar (admins only).
// ?target=me  connects the signed-in doctor's own calendar, so patients booked
//             with them land on their real calendar rather than a shared one.
// ?target=platform connects VAANIYANTRA's own calendar, for "book a call with
//             our team". Super-admin only — no org role reaches it.
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const target = parseTarget(new URL(req.url).searchParams.get('target'));
  if (target === 'platform') {
    if (!isSuperAdmin(ctx.user.email)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else {
    const denied = deny(ctx, target === 'me' ? 'integration:connect_self' : 'integration:manage');
    if (denied) return denied;
  }

  if (!googleOAuthConfigured()) {
    return NextResponse.json(
      { error: 'Google OAuth is not configured on the server (set GOOGLE_OAUTH_CLIENT_ID/SECRET).' },
      { status: 400 },
    );
  }

  // The target rides inside the state value rather than in a second cookie, so
  // the callback learns which connection to write while the CSRF check stays
  // exactly what it was — a comparison of the random half.
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = NextResponse.redirect(buildAuthUrl(encodeState(target, nonce)));
  res.cookies.set('g_oauth_state', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return res;
}
