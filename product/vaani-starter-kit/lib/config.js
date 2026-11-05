/**
 * Where the settings live, and the schema the setup screen is built from.
 *
 * Settings are saved to config.json by the setup screen. On startup they are
 * copied into process.env, so every other module in the kit just reads
 * process.env and does not care whether a value came from the setup screen, a
 * .env file, or the real environment.
 *
 * Precedence, highest first:
 *
 *   1. A real environment variable — so a production host's dashboard wins.
 *   2. config.json — what the setup screen wrote.
 *   3. .env — still works, for people who prefer a text file.
 *
 * FIELDS below is the single source of truth. The setup page renders itself
 * from it, the save endpoint validates against it, and nothing has to be kept
 * in sync by hand.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = join(ROOT, 'config.json');

/**
 * `secret: true` means the value is masked once saved — the setup screen shows
 * "••••••1234" and only sends a new value when the field is actually edited.
 * Without this, opening the page and saving would blank every key you had.
 */
export const FIELDS = [
  // ── Step 1: the business ──────────────────────────────────────────────────
  { key: 'BUSINESS_NAME', step: 'business', label: 'Business name', placeholder: 'Bright Smile Dental', required: true },
  { key: 'BUSINESS_TYPE', step: 'business', label: 'What kind of business', placeholder: 'dental clinic', required: true,
    help: 'Drives the vocabulary the agent uses and what it treats as out of scope.' },
  { key: 'AGENT_NAME', step: 'business', label: 'What the agent calls itself', placeholder: 'Maya', required: true },
  { key: 'BUSINESS_TIMEZONE', step: 'business', label: 'Timezone', type: 'timezone', required: true,
    help: 'Must be a full name like Asia/Kolkata. Get this wrong and bookings land on the wrong day.' },
  { key: 'AGENT_GREETING', step: 'business', label: 'Opening line', type: 'textarea',
    placeholder: 'Leave blank for a sensible default.' },

  // ── Step 2: the brain ─────────────────────────────────────────────────────
  { key: 'GEMINI_API_KEY', step: 'ai', label: 'Gemini API key', secret: true, required: true,
    help: 'Free from aistudio.google.com/apikey' },
  { key: 'GEMINI_LIVE_MODEL', step: 'ai', label: 'Model', type: 'select',
    options: [
      { value: 'gemini-2.5-flash-native-audio-latest', label: 'Native audio — most human, follows the caller\'s language' },
      { value: 'gemini-2.5-flash-live-preview', label: 'Half-cascade — faster and cheaper, fixed language' },
    ],
    default: 'gemini-2.5-flash-native-audio-latest' },
  { key: 'AGENT_VOICE', step: 'ai', label: 'Voice', type: 'select',
    options: ['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr'].map((v) => ({ value: v, label: v })),
    default: 'Aoede' },
  { key: 'AGENT_LANGUAGE', step: 'ai', label: 'Language', type: 'select',
    options: [
      { value: 'en-IN', label: 'English (India)' }, { value: 'en-US', label: 'English (US)' },
      { value: 'en-GB', label: 'English (UK)' }, { value: 'hi-IN', label: 'Hindi' },
      { value: 'te-IN', label: 'Telugu' }, { value: 'ta-IN', label: 'Tamil' },
      { value: 'mr-IN', label: 'Marathi' }, { value: 'es-ES', label: 'Spanish' },
      { value: 'ar-XA', label: 'Arabic' }, { value: 'de-DE', label: 'German' },
    ],
    default: 'en-IN',
    help: 'Ignored by the native-audio model, which follows whatever the caller speaks.' },

  // ── Step 3: the phone line ────────────────────────────────────────────────
  { key: 'TELEPHONY_PROVIDER', step: 'phone', label: 'Provider', type: 'select',
    options: [
      { value: 'twilio', label: 'Twilio — worldwide, self-serve' },
      { value: 'exotel', label: 'Exotel — India, needs KYC' },
    ],
    default: 'twilio', required: true },

  { key: 'TWILIO_ACCOUNT_SID', step: 'phone', when: { TELEPHONY_PROVIDER: 'twilio' }, label: 'Account SID', placeholder: 'AC…', required: true },
  { key: 'TWILIO_AUTH_TOKEN', step: 'phone', when: { TELEPHONY_PROVIDER: 'twilio' }, label: 'Auth token', secret: true, required: true },

  { key: 'EXOTEL_ACCOUNT_SID', step: 'phone', when: { TELEPHONY_PROVIDER: 'exotel' }, label: 'Account SID', required: true },
  { key: 'EXOTEL_API_KEY', step: 'phone', when: { TELEPHONY_PROVIDER: 'exotel' }, label: 'API key', required: true },
  { key: 'EXOTEL_API_TOKEN', step: 'phone', when: { TELEPHONY_PROVIDER: 'exotel' }, label: 'API token', secret: true, required: true },
  { key: 'EXOTEL_SUBDOMAIN', step: 'phone', when: { TELEPHONY_PROVIDER: 'exotel' }, label: 'Region host', type: 'select',
    options: [
      { value: 'api.in.exotel.com', label: 'India (api.in.exotel.com)' },
      { value: 'api.exotel.com', label: 'Default (api.exotel.com)' },
      { value: 'api.sg.exotel.com', label: 'Singapore (api.sg.exotel.com)' },
    ],
    default: 'api.in.exotel.com' },

  { key: 'PUBLIC_URL', step: 'phone', label: 'Public URL of this server', placeholder: 'https://something.ngrok-free.app', required: true,
    help: 'Must be https. In development this is your ngrok URL.' },

  // ── Step 4: WhatsApp (optional) ───────────────────────────────────────────
  { key: 'WHATSAPP_PHONE_NUMBER_ID', step: 'whatsapp', label: 'Phone number ID' },
  { key: 'WHATSAPP_ACCESS_TOKEN', step: 'whatsapp', label: 'Access token', secret: true,
    help: 'Use a permanent System User token. The one shown in the app dashboard expires in 24 hours.' },
  { key: 'WHATSAPP_TEMPLATE_NAME', step: 'whatsapp', label: 'Template name', default: 'appointment_confirmation' },
  { key: 'WHATSAPP_TEMPLATE_LANG', step: 'whatsapp', label: 'Template language', default: 'en' },
  { key: 'WHATSAPP_COUNTRY_CODE', step: 'whatsapp', label: 'Default country code', placeholder: '91',
    help: 'Used when a caller ID arrives without one, e.g. 09876543210.' },

  // ── Step 5: calendar (optional, OAuth) ────────────────────────────────────
  { key: 'GOOGLE_CLIENT_ID', step: 'calendar', label: 'Client ID', placeholder: '….apps.googleusercontent.com' },
  { key: 'GOOGLE_CLIENT_SECRET', step: 'calendar', label: 'Client secret', secret: true },
  { key: 'GOOGLE_REFRESH_TOKEN', step: 'calendar', label: 'Refresh token', secret: true, readOnly: true,
    help: 'Filled in for you by the Connect button.' },
  { key: 'GOOGLE_CALENDAR_ID', step: 'calendar', label: 'Calendar', default: 'primary' },

  // ── Step 6: hours ─────────────────────────────────────────────────────────
  { key: 'OPEN_HOUR', step: 'hours', label: 'Opens at', type: 'hour', default: '9' },
  { key: 'CLOSE_HOUR', step: 'hours', label: 'Closes at', type: 'hour', default: '17' },
  { key: 'OPEN_DAYS', step: 'hours', label: 'Open days', type: 'days', default: '1,2,3,4,5' },
  { key: 'SLOT_MINUTES', step: 'hours', label: 'Appointment length (minutes)', type: 'number', default: '30' },
  { key: 'RECORDING_DISCLOSURE', step: 'hours', label: 'Announce that calls may be recorded', type: 'boolean', default: 'false',
    help: 'Required by law in some places. Check what applies where your callers are.' },
  { key: 'SILENCE_MS', step: 'hours', label: 'Pause before the agent replies (ms)', type: 'number', default: '300',
    help: 'Lower is snappier. Too low and it interrupts anyone who pauses to think.' },
];

export const STEPS = [
  { key: 'business', title: 'Your business', blurb: 'What the agent says it is.' },
  { key: 'ai', title: 'Voice & AI', blurb: 'The brain and the voice it speaks with.' },
  { key: 'phone', title: 'Phone line', blurb: 'Where the calls come from.' },
  { key: 'whatsapp', title: 'WhatsApp', blurb: 'Confirmations after a booking. Optional.', optional: true },
  { key: 'calendar', title: 'Calendar', blurb: 'Real availability and real bookings. Optional.', optional: true },
  { key: 'hours', title: 'Hours & rules', blurb: 'When you are open and how the agent behaves.' },
];

const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const isKnownField = (key) => Object.hasOwn(FIELD_BY_KEY, key);
export const fieldFor = (key) => FIELD_BY_KEY[key];

/** What is in config.json right now. Never throws. */
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.warn('[config] config.json is unreadable — ignoring it. Re-save from /setup to rebuild it.');
    return {};
  }
}

/**
 * Copy saved settings into process.env.
 *
 * A real environment variable always wins, so deploying to a host that sets its
 * own variables behaves the way anyone would expect, and config.json becomes a
 * fallback rather than a surprise.
 */
export function applyToEnv(config = loadConfig()) {
  for (const field of FIELDS) {
    const saved = config[field.key];
    const live = process.env[field.key];
    if (live !== undefined && live !== '') continue;
    const value = saved !== undefined && saved !== '' ? saved : field.default;
    if (value !== undefined && value !== '') process.env[field.key] = String(value);
  }
}

/** Merge a patch into config.json and make it live immediately. */
export function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (!isKnownField(key)) continue; // never persist something not in the schema
    if (value === null) {
      delete next[key];
      continue;
    }
    next[key] = String(value).trim();
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));

  // Saved values must take effect without a restart, so overwrite rather than
  // deferring to what is already in process.env from an earlier save.
  for (const key of Object.keys(patch)) {
    if (!isKnownField(key)) continue;
    const value = next[key];
    if (value === undefined || value === '') delete process.env[key];
    else process.env[key] = String(value);
  }

  return next;
}

/** "••••••4f21" — enough to recognise a key, not enough to use it. */
export function maskSecret(value) {
  if (!value) return '';
  const tail = String(value).slice(-4);
  return '••••••' + tail;
}

/**
 * The config as the setup screen should see it: secrets masked, defaults
 * applied, and a note of which keys are locked by a real environment variable
 * so the page can grey them out instead of letting someone edit a field that
 * will not take effect.
 */
export function configForUi() {
  const saved = loadConfig();
  const values = {};
  const masked = {};
  const lockedByEnv = [];

  for (const field of FIELDS) {
    const raw = saved[field.key] ?? field.default ?? '';
    if (field.secret && raw) {
      values[field.key] = maskSecret(raw);
      masked[field.key] = true;
    } else {
      values[field.key] = raw;
    }
    // process.env holds our own applied values too, so compare against what we
    // did not put there: a value present in env but absent from config.json.
    if (process.env[field.key] && !saved[field.key] && !field.default) {
      lockedByEnv.push(field.key);
    }
  }

  return { values, masked, lockedByEnv };
}

/** Which required fields are still empty, per step. */
export function missingRequired(config = loadConfig()) {
  const provider = config.TELEPHONY_PROVIDER || process.env.TELEPHONY_PROVIDER || 'twilio';
  return FIELDS.filter((f) => {
    if (!f.required) return false;
    if (f.when && f.when.TELEPHONY_PROVIDER && f.when.TELEPHONY_PROVIDER !== provider) return false;
    const value = config[f.key] ?? process.env[f.key] ?? f.default;
    return !value;
  }).map((f) => f.key);
}
