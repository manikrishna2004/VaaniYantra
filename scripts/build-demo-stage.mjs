/**
 * Build the demo stage page with the real call audio inlined.
 *
 *   node scripts/build-demo-stage.mjs                        # ad #1, the toothache call
 *   node scripts/build-demo-stage.mjs --variant reschedule   # ad #2
 *
 * sales/demo-stage[-variant].src.html is the editable source; the audio is a
 * __AUDIO_DATA_URI__ placeholder in it. This script substitutes a base64 data
 * URI and writes sales/demo-stage[-variant].html, which is what gets published.
 *
 * Why inline rather than reference a file: a published artifact is served under
 * a strict CSP that blocks every external host, and this account has no asset
 * store — so a self-contained page is the only way the audio travels with it.
 *
 * Keep the source editable and re-run this after changing it. Do not hand-edit
 * sales/demo-stage.html: it is ~1.6MB of base64 and will be overwritten.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// Which ad. No flag is ad #1, so the original invocation resolves to exactly the
// paths it always did; a variant adds its own suffix and brings its own audio.
const vAt = process.argv.indexOf('--variant');
const VARIANT = vAt > -1 && process.argv[vAt + 1] ? process.argv[vAt + 1] : '';
const SUFFIX = VARIANT ? `-${VARIANT}` : '';

const SRC = join(ROOT, 'sales', `demo-stage${SUFFIX}.src.html`);
const AUDIO = join(ROOT, 'sales', 'media', VARIANT ? `${VARIANT}-call.m4a` : 'demo-call.m4a');
const LOGO = join(ROOT, 'public', 'logo.png');
const OUT = join(ROOT, 'sales', `demo-stage${SUFFIX}.html`);

// A published artifact must render under 16MB, and base64 costs ~33% on top of
// the raw bytes. Fail loudly well before that rather than publishing a page the
// viewer silently refuses.
const MAX_PAGE_BYTES = 16 * 1024 * 1024;

for (const [label, path] of [['source', SRC], ['audio', AUDIO]]) {
  if (!existsSync(path)) {
    console.error(`✖ missing ${label}: ${path}`);
    process.exit(1);
  }
}

const src = readFileSync(SRC, 'utf8');
if (!src.includes('__AUDIO_DATA_URI__')) {
  console.error('✖ source has no __AUDIO_DATA_URI__ placeholder — nothing to inline.');
  process.exit(1);
}

const audio = readFileSync(AUDIO);
const dataUri = `data:audio/mp4;base64,${audio.toString('base64')}`;
let out = src.replace('__AUDIO_DATA_URI__', dataUri);

// The brand mark on the closing card. Inlined for the same reason as the audio:
// a published artifact cannot fetch anything from another host.
if (out.includes('__LOGO_DATA_URI__')) {
  if (!existsSync(LOGO)) {
    console.error(`✖ missing logo: ${LOGO}`);
    process.exit(1);
  }
  out = out.replace('__LOGO_DATA_URI__', `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`);
}

if (Buffer.byteLength(out, 'utf8') > MAX_PAGE_BYTES) {
  console.error(
    `✖ page would be ${(Buffer.byteLength(out, 'utf8') / 1048576).toFixed(1)}MB, over the 16MB artifact limit.\n` +
      '  Re-encode the audio smaller, e.g.:\n' +
      `  ffmpeg -i input.m4a -c:a aac -b:a 32k -ac 1 ${AUDIO}`,
  );
  process.exit(1);
}

writeFileSync(OUT, out, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(`▶ built sales/demo-stage${SUFFIX}.html`);
console.log(`  audio   ${kb(statSync(AUDIO).size)} → ${kb(dataUri.length)} as base64`);
console.log(`  page    ${kb(Buffer.byteLength(out, 'utf8'))}`);
console.log(`  publish this file; edit demo-stage${SUFFIX}.src.html and re-run to change it.`);
