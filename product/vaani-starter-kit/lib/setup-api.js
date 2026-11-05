/**
 * The setup screen's back end: saving settings, running the connection tests
 * in lib/tests.js, and walking the buyer through Google's OAuth consent.
 *
 * Everything here reads or writes API keys, so server.js serves these routes
 * only to requests that arrived on the loopback interface. They must never be
 * reachable through the public tunnel.
 */

import { saveConfig, configForUi, loadConfig, isKnownField, maskSecret, FIELDS, STEPS, missingRequired } from './config.js';
import { providerFor } from './providers.js';
import { TESTS } from './tests.js';
import { HELP } from './help.js';

/**
 * Is this incoming value the mask we sent out, rather than a new secret?
 *
 * The setup page only sends fields the user actually edited, so in normal use
 * this never triggers. It exists because the cost of getting it wrong is
 * silently overwriting someone's live API key with six bullet characters, and
 * the bullets do not always survive the trip — a client that mangles UTF-8
 * sends back something that is visibly a mask but does not match one.
 *
 * So rather than comparing strings, ask the shape: same length as the mask,
 * same last four characters, and nothing alphanumeric in the part that should
 * be bullets.
 */
function looksLikeMask(value, stored) {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('••••••')) return true;
  if (!stored) return false;

  const mask = maskSecret(stored);
  if (value.length !== mask.length) return false;
  if (value.slice(-4) !== String(stored).slice(-4)) return false;
  return !/[a-zA-Z0-9]/.test(value.slice(0, -4));
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// ── Google OAuth ────────────────────────────────────────────────────────────
//
// This is why the setup screen exists. Doing it by hand means the OAuth
// playground, a scope list and copying a refresh token out of a web tool — the
// step that loses the most people. Here it is one button.

function googleRedirectUri() {
  // Deliberately the LOCAL address, not PUBLIC_URL. Google accepts http for
  // localhost but not for any other host, so a buyer without a tunnel can still
  // finish setup, and the tunnel URL changing does not invalidate the
  // registered redirect.
  return 'http://localhost:' + (process.env.PORT || 8080) + '/setup/google/callback';
}

function googleAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    // Without both of these Google returns an access token only, and the agent
    // stops booking an hour later with no obvious cause.
    access_type: 'offline',
    prompt: 'consent',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

async function exchangeGoogleCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || 'HTTP ' + res.status);
  if (!body.refresh_token) {
    throw new Error(
      'Google returned no refresh token. This happens when the account has already authorised this app — ' +
      'remove it at myaccount.google.com/permissions and connect again.',
    );
  }
  return body.refresh_token;
}

const resultPage = (title, message, good) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:15px/1.6 system-ui,sans-serif;background:#0f1115;color:#e8eaf0;
       display:grid;place-items:center;height:100vh;margin:0;text-align:center}
  .card{max-width:30rem;padding:2rem}
  h1{font-size:1.25rem;margin:0 0 .5rem;color:${good ? '#6ee7a8' : '#ff8f8f'}}
  p{color:#aab2c4;margin:0 0 1.5rem}
  a{color:#8b7fff}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p>
<p><a href="/setup">Back to setup</a></p></div>
<script>
  // The setup page opened this in a popup and is waiting to hear how it went.
  if (window.opener) { window.opener.postMessage({ googleConnected: ${good ? 'true' : 'false'} }, '*'); setTimeout(() => window.close(), ${good ? 1200 : 8000}); }
</script></body></html>`;

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Handle a /setup/* request. Returns true if it took the request.
 *
 * Bound to localhost only by the caller — these endpoints read and write API
 * keys, and must never be reachable through the public tunnel.
 */
export async function handleSetupApi(req, res, url) {
  const path = url.pathname;

  if (path === '/setup/schema' && req.method === 'GET') {
    json(res, 200, { fields: FIELDS, steps: STEPS, help: HELP });
    return true;
  }

  if (path === '/setup/config' && req.method === 'GET') {
    json(res, 200, { ...configForUi(), missing: missingRequired() });
    return true;
  }

  if (path === '/setup/config' && req.method === 'POST') {
    const patch = await readJsonBody(req);
    const stored = loadConfig();
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!isKnownField(key)) continue;
      // Never let a mask overwrite the real secret behind it.
      if (looksLikeMask(value, stored[key])) continue;
      clean[key] = value;
    }
    const saved = saveConfig(clean);
    json(res, 200, { saved: Object.keys(clean), missing: missingRequired(saved) });
    return true;
  }

  if (path === '/setup/test' && req.method === 'POST') {
    const { what } = await readJsonBody(req);
    const test = TESTS[what];
    if (!test) {
      json(res, 400, { ok: false, message: 'Nothing to test called "' + what + '".' });
      return true;
    }
    json(res, 200, await test());
    return true;
  }

  if (path === '/setup/google/start') {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      res.writeHead(200, { 'content-type': 'text/html' })
        .end(resultPage('Client ID and secret first', 'Save your Google client ID and secret, then press Connect again.', false));
      return true;
    }
    res.writeHead(302, { location: googleAuthUrl() }).end();
    return true;
  }

  if (path === '/setup/google/callback') {
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      res.writeHead(200, { 'content-type': 'text/html' })
        .end(resultPage('Not connected', error === 'access_denied' ? 'You declined the permission request.' : 'Google did not send a code back.', false));
      return true;
    }
    try {
      const refreshToken = await exchangeGoogleCode(code);
      saveConfig({ GOOGLE_REFRESH_TOKEN: refreshToken });
      res.writeHead(200, { 'content-type': 'text/html' })
        .end(resultPage('Calendar connected', 'You can close this window.', true));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'text/html' })
        .end(resultPage('Could not connect', err.message, false));
    }
    return true;
  }

  if (path === '/setup/google/redirect-uri' && req.method === 'GET') {
    json(res, 200, { redirectUri: googleRedirectUri() });
    return true;
  }

  // What the buyer must paste into their provider's dashboard, spelled out.
  if (path === '/setup/webhook' && req.method === 'GET') {
    const provider = providerFor(process.env.TELEPHONY_PROVIDER || 'twilio');
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    json(res, 200, {
      provider: provider.key,
      usesAnswerWebhook: provider.usesAnswerWebhook,
      // Null for Exotel, so nobody pastes an answer URL into a provider that
      // never asks for one and then wonders why calls go nowhere.
      answerUrl: publicUrl && provider.usesAnswerWebhook ? publicUrl + '/voice' : null,
      streamUrl: publicUrl ? publicUrl.replace(/^http/, 'ws') + provider.wsPath : null,
    });
    return true;
  }

  return false;
}
