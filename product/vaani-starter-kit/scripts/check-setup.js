/**
 * `npm run check` — the setup screen's Test buttons, from the terminal.
 *
 * The setup screen is the friendlier way to do this. This exists for two cases
 * the browser cannot cover: a deployed server you only reach over SSH, and a
 * quick "is anything broken?" before you ring the number.
 *
 * Same tests, same messages — lib/tests.js is the only implementation.
 */

import 'dotenv/config';
import { applyToEnv, missingRequired } from '../lib/config.js';
import { providerFor } from '../lib/providers.js';
import { TESTS } from '../lib/tests.js';

applyToEnv();

const provider = providerFor(process.env.TELEPHONY_PROVIDER || 'twilio');

// Only test the telephony provider actually in use — reporting a Twilio
// failure to someone who chose Exotel is just noise.
const plan = [
  ['Gemini', 'gemini'],
  [provider.label, provider.key],
  ['Public URL', 'publicUrl'],
  ['WhatsApp', 'whatsapp'],
  ['Calendar', 'calendar'],
];

const missing = missingRequired();

console.log('');
const results = [];
for (const [label, key] of plan) {
  const result = await TESTS[key]();
  results.push({ label, result });
  const mark = result.ok ? '  ok  ' : ' FAIL ';
  console.log('[' + mark + '] ' + label.padEnd(12) + result.message);
  const extra = result.detail || result.hint;
  if (extra) console.log('            ' + extra);
}
console.log('');

if (missing.length) {
  console.log('Still to fill in: ' + missing.join(', '));
  console.log('Open http://localhost:' + (process.env.PORT || 8080) + '/setup');
  console.log('');
  process.exit(1);
}

// WhatsApp and the calendar are optional; the agent runs without them.
const required = results.filter((r) => !['WhatsApp', 'Calendar'].includes(r.label));
if (required.some((r) => !r.result.ok)) {
  console.log('Fix the FAIL lines above before you ring the number.');
  console.log('');
  process.exit(1);
}

if (provider.usesAnswerWebhook) {
  console.log('Ready. Point your ' + provider.label + ' number at ' +
    (process.env.PUBLIC_URL || '').replace(/\/+$/, '') + '/voice and call it.');
} else {
  console.log('Ready. Point your ' + provider.label + ' Voicebot applet at ' +
    (process.env.PUBLIC_URL || '').replace(/\/+$/, '').replace(/^http/, 'ws') + provider.wsPath + ' and call it.');
}
console.log('');
