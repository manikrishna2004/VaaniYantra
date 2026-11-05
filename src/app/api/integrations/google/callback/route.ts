import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { exchangeCode } from '@/lib/google-oauth';
import { saveCalendarConfig, primaryEmail, SHARED_CALENDAR_OWNER } from '@/lib/calendar';
import { decodeState } from '@/lib/google-target';
import { isSuperAdmin } from '@/lib/platform';
import { saveTeamCallConfig } from '@/lib/team-call';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const settingsUrl = (q: string) =>
  `${process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || ''}/connectors${q}`;

// Google redirects here after consent. Verify state, exchange the code, store
// the refresh token, and bounce back to the Calendar settings page.
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const savedState = (await cookies()).get('g_oauth_state')?.value;

  // The target came back inside `state`, which is round-tripped through Google
  // and therefore not trustworthy on its own — so re-check the permission for
  // whichever connection is about to be written. A member cannot smuggle
  // ?target=org past the connect route and land here with admin reach.
  const { target, nonce } = decodeState(state);
  // 'platform' writes VaaniYantra's OWN calendar, which is not tenant data and
  // no org role can reach — not even an OWNER's integration:manage. Checked
  // here rather than only on the connect route because `state` round-trips
  // through Google and is attacker-controllable in principle.
  if (target === 'platform') {
    if (!isSuperAdmin(ctx.user.email)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else {
    const denied = deny(ctx, target === 'me' ? 'integration:connect_self' : 'integration:manage');
    if (denied) return denied;
  }

  // Clear the state cookie regardless of outcome.
  const fail = (reason: string) => {
    const res = NextResponse.redirect(settingsUrl(`?error=${encodeURIComponent(reason)}`));
    res.cookies.delete('g_oauth_state');
    return res;
  };

  if (oauthError) return fail(oauthError);
  if (!code || !nonce || !savedState || nonce !== savedState) return fail('state_mismatch');

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      // No refresh token (already-granted without prompt=consent). Ask to retry.
      return fail('no_refresh_token');
    }
    const email = await primaryEmail(tokens.access_token);

    // The team-call calendar goes to PlatformConfig, not the Integration table.
    if (target === 'platform') {
      await saveTeamCallConfig({
        refreshToken: tokens.refresh_token,
        calendarId: 'primary',
        email,
        timezone: 'Asia/Kolkata',
      });
      await audit(ctx, 'platform.team_call_calendar_connected', {
        targetType: 'Platform',
        metadata: { email },
        req,
      });
      const ok = NextResponse.redirect(
        `${process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || ''}/admin?connected=platform`,
      );
      ok.cookies.delete('g_oauth_state');
      return ok;
    }

    // 'me' writes the doctor's own connection; 'org' writes the clinic's shared
    // one (the "" sentinel).
    const owner = target === 'me' ? ctx.user.id : SHARED_CALENDAR_OWNER;
    await saveCalendarConfig(
      ctx.org.id,
      ctx.user.id,
      { refreshToken: tokens.refresh_token, calendarId: 'primary', email },
      owner,
    );
    await audit(ctx, 'integration.saved', {
      targetType: 'Integration',
      metadata: { provider: 'googleCalendar', email, target },
      req,
    });
    const res = NextResponse.redirect(settingsUrl(`?connected=${target}`));
    res.cookies.delete('g_oauth_state');
    return res;
  } catch (err: any) {
    console.error('[google oauth] callback failed', err);
    return fail('exchange_failed');
  }
}
