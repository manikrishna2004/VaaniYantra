/**
 * Does each credential actually work?
 *
 * One implementation, used by both the setup screen's Test buttons and
 * `npm run check`. Two copies of this would drift, and the CLI one would be
 * the stale one — it is the one nobody looks at until something breaks.
 *
 * Every test makes a real authenticated request. A key that is merely
 * well-formed tells you nothing: a revoked Twilio token and a live one look
 * identical in a text box, and the difference only shows up on a call.
 */

const ok = (message, detail) => ({ ok: true, message, detail });
const fail = (message, hint) => ({ ok: false, message, hint });

/**
 * Is the key good AND can it actually hold a call?
 *
 * Listing models is not enough, and believing it is costs a whole afternoon.
 * A key with no billing behind it lists every model happily, then closes the
 * realtime session the instant you open one — the agent answers the phone and
 * says nothing. So this opens a real Live session and waits to see whether it
 * survives. Nothing is spoken and no audio is sent, so it costs essentially
 * nothing, and it is the only check that matches what a caller experiences.
 */
async function testGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail('No API key saved yet.');

  const wanted = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest';

  // Step 1: is the key real, and does the chosen model exist for it?
  let live = [];
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=' + encodeURIComponent(key),
    );
    const body = await res.json();
    if (!res.ok) {
      return fail(body?.error?.message || 'Key rejected (HTTP ' + res.status + ')',
        'Create a fresh key at aistudio.google.com/apikey');
    }
    const models = (body.models || []).map((m) => ({
      name: (m.name || '').replace('models/', ''),
      bidi: (m.supportedGenerationMethods || []).some((x) => /bidi/i.test(x)),
    }));
    live = models.filter((m) => m.bidi).map((m) => m.name);

    if (!models.some((m) => m.name === wanted)) {
      return fail('This key has no model called "' + wanted + '".',
        live.length ? 'Realtime models it does have: ' + live.slice(0, 4).join(', ') : 'It has no realtime models at all.');
    }
    if (!live.includes(wanted)) {
      return fail('"' + wanted + '" exists but cannot do realtime calls.',
        live.length ? 'Pick one of: ' + live.slice(0, 4).join(', ') : undefined);
    }
  } catch (err) {
    return fail('Could not reach Google: ' + err.message);
  }

  // Step 2: open a real session. This is where billing problems surface.
  try {
    const { GoogleGenAI, Modality } = await import('@google/genai');
    delete process.env.GOOGLE_API_KEY;
    const ai = new GoogleGenAI({ apiKey: key });

    const outcome = await new Promise(async (resolve) => {
      let session = null;
      const done = (value) => {
        clearTimeout(timer);
        try { session?.close(); } catch { /* already gone */ }
        resolve(value);
      };
      // Surviving a couple of seconds without being closed means the session is
      // genuinely usable; a rejected one is torn down almost immediately.
      const timer = setTimeout(() => done({ usable: true }), 2500);

      try {
        session = await ai.live.connect({
          model: wanted,
          config: { responseModalities: [Modality.AUDIO] },
          callbacks: {
            onopen: () => {},
            onmessage: () => {},
            onerror: (e) => done({ usable: false, reason: e?.message || String(e) }),
            onclose: (e) => done({ usable: false, reason: e?.reason || 'closed without a reason' }),
          },
        });
      } catch (err) {
        done({ usable: false, reason: err?.message || String(err) });
      }
    });

    if (outcome.usable) {
      return ok('Key works and can hold a live call.', wanted + ' — ' + live.length + ' realtime model(s) available.');
    }

    const reason = String(outcome.reason);

    // Billing is far and away the most common cause, and the least obvious:
    // everything else about the key looks perfect.
    if (/credit|billing|quota|exhaust|deplete|payment|paid/i.test(reason)) {
      return fail('Your key is valid, but the Google project cannot run live calls.',
        reason.slice(0, 200) + ' — the Live API is billed. Add credits or enable billing at ai.studio/projects, ' +
        'then test again. Until then the agent will answer and say nothing.');
    }
    if (/permission|denied|not authorized|access/i.test(reason)) {
      return fail('The key is valid but not allowed to use the Live API.', reason.slice(0, 200));
    }
    return fail('The key lists models, but a live session closed straight away.', reason.slice(0, 220));
  } catch (err) {
    return fail('Could not open a live session: ' + (err?.message || String(err)));
  }
}

async function testTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return fail('Account SID and auth token are both needed.');
  if (!sid.startsWith('AC')) return fail('That does not look like an Account SID.', 'It starts with "AC". The one starting "SK" is an API key.');

  try {
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const res = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/IncomingPhoneNumbers.json?PageSize=20',
      { headers: { authorization: 'Basic ' + auth } },
    );
    if (res.status === 401) return fail('Twilio rejected those credentials.', 'Check the auth token — it is hidden by default in the console.');
    if (!res.ok) return fail('Twilio returned HTTP ' + res.status + '.');

    const { incoming_phone_numbers: nums = [] } = await res.json();
    if (!nums.length) {
      return { ok: true, message: 'Credentials work, but this account owns no phone number yet.',
        detail: 'Buy one under Phone Numbers → Buy a number, with Voice capability.' };
    }
    return ok('Connected. ' + nums.length + ' number(s) on this account.',
      nums.map((n) => n.phone_number).join(', '));
  } catch (err) {
    return fail('Could not reach Twilio: ' + err.message);
  }
}

async function testExotel() {
  const sid = process.env.EXOTEL_ACCOUNT_SID;
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  const host = process.env.EXOTEL_SUBDOMAIN || 'api.in.exotel.com';
  if (!sid || !key || !token) return fail('Account SID, API key and API token are all needed.');

  try {
    const auth = Buffer.from(key + ':' + token).toString('base64');
    const url = 'https://' + host + '/v1/Accounts/' + sid + '.json';
    const res = await fetch(url, { headers: { authorization: 'Basic ' + auth } });

    if (res.status === 401) {
      // Exotel answers 401 for a bad key/token AND for a good pair pointed at
      // the wrong Account SID or the wrong regional host. Saying which one
      // saves a long afternoon, so name all three possibilities.
      return fail('Exotel rejected that (401).',
        'A 401 here means one of three things: wrong API key/token, wrong Account SID, or the wrong region host. You tried ' + host + '.');
    }
    if (!res.ok) return fail('Exotel returned HTTP ' + res.status + '.');

    // Numbers are best-effort — Exotel's shape varies by account and region.
    let detail;
    try {
      const numRes = await fetch('https://' + host + '/v1/Accounts/' + sid + '/IncomingPhoneNumbers.json',
        { headers: { authorization: 'Basic ' + auth } });
      if (numRes.ok) {
        const data = await numRes.json();
        const raw = data?.IncomingPhoneNumber ?? data?.IncomingPhoneNumbers?.IncomingPhoneNumber ?? [];
        const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
        if (list.length) detail = list.map((n) => n.PhoneNumber || n.phone_number).filter(Boolean).join(', ');
      }
    } catch { /* listing is optional */ }

    return ok('Connected to Exotel.', detail);
  } catch (err) {
    return fail('Could not reach Exotel: ' + err.message);
  }
}

async function testWhatsapp() {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!id || !token) return fail('Phone number ID and access token are both needed.');

  try {
    const res = await fetch(
      'https://graph.facebook.com/v21.0/' + id + '/message_templates?fields=name,status,language&limit=50',
      { headers: { authorization: 'Bearer ' + token } },
    );
    const body = await res.json();
    if (!res.ok) {
      const code = body?.error?.code;
      if (code === 190) return fail('That token has expired or been revoked.', 'The token in the app dashboard lasts 24 hours. Create a permanent System User token instead.');
      return fail(body?.error?.message || 'HTTP ' + res.status);
    }

    const wanted = process.env.WHATSAPP_TEMPLATE_NAME || 'appointment_confirmation';
    const tpl = (body.data || []).find((t) => t.name === wanted);
    if (!tpl) {
      const names = (body.data || []).map((t) => t.name).slice(0, 5);
      return fail('No template called "' + wanted + '".',
        names.length ? 'This account has: ' + names.join(', ') : 'Create one in WhatsApp Manager, category Utility.');
    }
    if (tpl.status !== 'APPROVED') {
      return { ok: true, message: 'Template found, but it is ' + tpl.status + '.',
        detail: 'Confirmations will not send until Meta approves it.' };
    }
    return ok('Template "' + wanted + '" is approved (' + tpl.language + ').');
  } catch (err) {
    return fail('Could not reach Meta: ' + err.message);
  }
}

async function testCalendar() {
  const { calendarConfigured, openSlots, todayISO } = await import('../connectors/calendar.js');
  if (!calendarConfigured()) return fail('Not connected yet.', 'Use the Connect Google Calendar button.');
  try {
    const slots = await openSlots(todayISO());
    return ok('Connected. ' + slots.length + ' slot(s) free today.',
      'Calendar: ' + (process.env.GOOGLE_CALENDAR_ID || 'primary'));
  } catch (err) {
    return fail(err.message);
  }
}

async function testPublicUrl() {
  const url = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (!url) return fail('Not set.', 'Run ngrok and paste the https URL it prints.');
  if (!url.startsWith('https://')) return fail('Must start with https://', 'Twilio and Exotel both refuse plain http.');
  try {
    const res = await fetch(url + '/health', { signal: AbortSignal.timeout(6000) });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    if (body.kit !== 'voice-agent-starter-kit') {
      // Something is at that address, but not us. Almost always a stale ngrok
      // URL — the free ones change on every restart — or a tunnel pointed at a
      // different local port.
      return fail('Something answered at that URL, but it was not this server.',
        'Check the tunnel is running and pointed at port ' + (process.env.PORT || 8080) +
        '. Free ngrok URLs change every time you restart it.');
    }
    return ok('Reachable from the internet.');
  } catch {
    return fail('Nothing answered at ' + url + '.',
      'Is the tunnel running? The free ngrok URL changes every restart.');
  }
}

export const TESTS = {
  gemini: testGemini,
  twilio: testTwilio,
  exotel: testExotel,
  whatsapp: testWhatsapp,
  calendar: testCalendar,
  publicUrl: testPublicUrl,
};

