/**
 * WhatsApp — the confirmation the caller keeps after they hang up.
 *
 * This is the highest-leverage connector in the kit and the one most likely to
 * silently do nothing, so read this before you debug it:
 *
 * WhatsApp has two kinds of outbound message, and they are not interchangeable.
 *
 *   FREE-FORM TEXT  works only inside a 24-hour window that opens when the
 *                   customer messages you first. A caller who just rang your
 *                   phone has not messaged you, so this window is shut, and
 *                   a text send returns a 131047 error.
 *
 *   TEMPLATE        works any time, to anyone, but the exact wording must be
 *                   submitted to Meta and approved in advance.
 *
 * So the booking confirmation must be a template. sendConfirmation below tries
 * the template first and falls back to text only for a caller already in an
 * open window.
 *
 * Leave WHATSAPP_* blank in .env and every function here becomes a no-op that
 * logs what it would have sent — the agent still works.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export function whatsappConfigured() {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

async function send(payload) {
  const res = await fetch(GRAPH + '/' + process.env.WHATSAPP_PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.WHATSAPP_ACCESS_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body.error || {};
    return { ok: false, code: err.code, error: err.message || 'HTTP ' + res.status, detail: err.error_data };
  }
  return { ok: true, id: body.messages?.[0]?.id };
}

/**
 * Phone numbers as WhatsApp wants them: digits only, country code included, no
 * plus, no spaces, no leading zero.
 *
 * Twilio hands you "+1 415 555 0123"; WhatsApp wants "14155550123". A caller ID
 * that arrives in national format ("09876543210") is ambiguous, so we take a
 * default country code and strip the trunk zero.
 */
export function normalizeNumber(raw, defaultCountryCode = '') {
  let digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (defaultCountryCode && !digits.startsWith(String(defaultCountryCode))) {
    digits = digits.replace(/^0+/, '');
    digits = String(defaultCountryCode) + digits;
  }
  return digits;
}

/** Plain text. Only lands inside an open 24-hour customer service window. */
export async function sendText(to, body) {
  const number = normalizeNumber(to, process.env.WHATSAPP_COUNTRY_CODE);
  if (!whatsappConfigured() || !number) {
    console.log('[whatsapp] not configured — would text', number, ':', body);
    return { ok: false, skipped: true };
  }
  return send({ to: number, type: 'text', text: { preview_url: false, body } });
}

/**
 * An approved template, with its {{1}}, {{2}} ... placeholders filled in order.
 * Works cold, which is why the confirmation uses it.
 */
export async function sendTemplate(to, name, variables = [], lang) {
  const number = normalizeNumber(to, process.env.WHATSAPP_COUNTRY_CODE);
  if (!whatsappConfigured() || !number) {
    console.log('[whatsapp] not configured — would send template', name, 'to', number, variables);
    return { ok: false, skipped: true };
  }
  return send({
    to: number,
    type: 'template',
    template: {
      name,
      language: { code: lang || process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
      components: variables.length
        ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) }]
        : [],
    },
  });
}

/**
 * The one message this kit actually sends: "your appointment is confirmed".
 *
 * Template first, text as a fallback. If both fail we log loudly rather than
 * throw — a caller who booked successfully should not have the call collapse
 * because a message did not go out.
 */
export async function sendConfirmation({ to, name, when, business }) {
  const businessName = business || process.env.BUSINESS_NAME || 'our clinic';
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'appointment_confirmation';

  const viaTemplate = await sendTemplate(to, templateName, [name || 'there', businessName, when]);
  if (viaTemplate.ok || viaTemplate.skipped) return viaTemplate;

  console.warn('[whatsapp] template "' + templateName + '" failed:', viaTemplate.code, viaTemplate.error);

  // 132001 = template does not exist in this WABA / wrong language code.
  // 131047 = outside the 24h window, so the text fallback below will fail too.
  if (viaTemplate.code === 132001) {
    console.warn('[whatsapp] create and get that template approved — see GUIDE section 5.4.');
  }

  const viaText = await sendText(
    to,
    'Hi ' + (name || 'there') + ', your appointment at ' + businessName + ' is confirmed for ' + when + '.',
  );
  if (!viaText.ok && !viaText.skipped) {
    console.warn('[whatsapp] text fallback also failed:', viaText.code, viaText.error);
  }
  return viaText;
}
