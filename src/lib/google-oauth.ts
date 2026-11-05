// Phase 6C — Google OAuth 2.0 (Calendar). Plain fetch against Google's OAuth
// endpoints (no SDK). The platform registers ONE OAuth client; each workspace
// connects its own Google account and we store the refresh token (encrypted).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Scopes for the Google connector. Space-separated for the OAuth request.
// ADDING a scope requires users to reconnect (re-consent); removing one from the
// REQUEST does not revoke a grant Google has already issued, so existing
// connections keep working — they simply carry a broader grant than we now ask
// for, until they reconnect or revoke it.
//
// `drive.file` was dropped when the Drive/Sheets integration was removed — a
// clinic exports its data as CSV instead.
//
// ⚠ THESE MUST MATCH THE SCOPES REGISTERED IN THE GOOGLE CLOUD CONSOLE
// (Google Auth Platform → Data Access) EXACTLY — not be a subset, not a
// superset. Google's verification checklist calls this "Scope Matching", and a
// mismatch fails the review whichever direction it runs in.
//
// The Console now registers exactly these five, so this list and that page were
// changed together, Console first:
//
//   calendar.events                 create/patch/delete/listEvents   [SENSITIVE]
//   calendar.freebusy               freeBusy()                       [non-sensitive]
//   calendar.calendarlist.readonly  listCalendars(), primaryEmail()  [non-sensitive]
//   openid + userinfo.email         who connected the account        [non-sensitive]
//
// This replaced the single `.../auth/calendar`, which also granted creating and
// deleting whole calendars and changing their sharing — none of which this app
// does, and which failed the checklist's first item, Least Privilege.
//
// An earlier attempt shipped this narrowing to production BEFORE the Console
// knew about it. That was wrong and was reverted the same day: Google's own
// guidance is "do not deploy unverified scopes to your production traffic —
// this will disrupt your users and may consume your unverified user quota",
// and the project's 100-user cap cannot be reset. Console first, always.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');
// Back-compat alias (older imports referenced CALENDAR_SCOPE).
export const CALENDAR_SCOPE = GOOGLE_SCOPES;

export function googleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function redirectUri(): string {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  return `${base}/api/integrations/google/callback`;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    access_type: 'offline', // get a refresh token
    prompt: 'consent', // force a refresh token even on re-consent
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Exchange a stored refresh token for a fresh access token (access tokens last
// ~1h; refresh tokens are long-lived).
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as TokenResponse;
  return json.access_token;
}
