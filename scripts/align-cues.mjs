/**
 * Align the call transcript to the recording using real word timings.
 *
 *   node scripts/align-cues.mjs                        # ad #1, print the cue sheet
 *   node scripts/align-cues.mjs --variant reschedule   # ad #2
 *   node scripts/align-cues.mjs --fetch                # re-transcribe first (~$0.01)
 *
 * What was said, and which files hold it, lives in scripts/cues/<variant>.mjs.
 * Everything here is the machinery that puts one on top of the other.
 *
 * This replaced a silence-detection heuristic that was wrong by four to six
 * seconds. That version guessed where turns began by splitting the file at
 * pauses and sharing each block's time between turns by character count. It
 * put the greeting at 0.00→9.58; the greeting actually ends at 5.14. No amount
 * of tuning a global offset could fix an error that varies per line.
 *
 * Deepgram returns a start time for every word, and diarisation for the turns.
 * Timings below are read off that. The TEXT stays the dashboard transcript,
 * verbatim — Deepgram mishears in places ("रमणा" for "रमना", "दाम" for "दांत"),
 * and the product's own transcript is what the clinic would see.
 *
 * Word times are emitted per cue so the page can reveal each word when it is
 * actually said, rather than spreading a line evenly across its duration.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Which recording this run is for. Defaults to ad #1, so the original
// invocation keeps working unchanged:
//   node scripts/align-cues.mjs --variant reschedule
const vAt = process.argv.indexOf('--variant');
const VARIANT = vAt > -1 && process.argv[vAt + 1] ? process.argv[vAt + 1] : 'toothache';
const CALL = await import(`./cues/${VARIANT}.mjs`);
const JSON_PATH = CALL.json;
const FLAC = CALL.flac;

if (process.argv.includes('--fetch')) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { console.error('✖ DEEPGRAM_API_KEY not set'); process.exit(1); }
  if (!existsSync(FLAC)) {
    console.error(`✖ ${FLAC} missing. Create it with:`);
    console.error(`  ffmpeg -i ${FLAC.replace(/\.flac$/, '.m4a')} -ar 16000 -ac 1 -c:a flac ${FLAC}`);
    process.exit(1);
  }
  const url = 'https://api.deepgram.com/v1/listen?model=nova-2&language=hi'
    + '&punctuate=true&utterances=true&diarize=true&smart_format=true';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/flac' },
    body: readFileSync(FLAC),
  });
  if (!res.ok) { console.error('✖ Deepgram', res.status, (await res.text()).slice(0, 300)); process.exit(1); }
  writeFileSync(JSON_PATH, JSON.stringify(await res.json(), null, 2));
  console.log(`▶ wrote ${JSON_PATH}`);
}

if (!existsSync(JSON_PATH)) {
  console.error(`✖ ${JSON_PATH} missing — run with --fetch`);
  process.exit(1);
}

const dg = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
const WORDS = dg.results.channels[0].alternatives[0].words || [];
const DURATION = dg.metadata?.duration ?? CALL.fallbackDuration;
const TURNS = CALL.turns(DURATION);

const wordStarts = (a, b) =>
  WORDS.filter((w) => w.start >= a - 0.001 && w.start < b).map((w) => +w.start.toFixed(2));

// Words that recognition and the transcript spell differently — one in Latin,
// one in Devanagari, or an abbreviation against its full form. Without these
// they never match and the alignment loses anchors exactly where the interesting
// content is: the doctors' names.
const EQUIV = [
  ['dr', 'doctor', 'डॉक्टर'],
  ['rahul', 'राहुल'], ['mehta', 'मेहता'],
  ['aditi', 'अदिति'], ['sharma', 'शर्मा'],
  ['time', 'टाइम'], ['book', 'बुक'], ['appointment', 'अपॉइंटमेंट'],
  ['please', 'प्लीज'], ['consultation', 'कंसल्टेशन'], ['fee', 'फी'],
  ['details', 'डिटेल्स'], ['slot', 'स्लॉट'], ['available', 'अवेलेबल'],
  ['ramana', 'रमना', 'रमणा'],
  ['cancel', 'कैंसल'], ['reschedule', 'रीशेड्यूल'],
  ['slots', 'स्लॉट्स'], ['whatsapp', 'व्हाट्सएप'], ['message', 'मैसेज'],
  ['prefer', 'प्रेफर'], ['august', 'अगस्त'], ['sorry', 'सॉरी'],
];
const CANON = new Map();
for (const group of EQUIV) for (const form of group) CANON.set(form, group[0]);

const norm = (w) => {
  const t = w.toLowerCase()
    .replace(/[।.,?!:;"'’“”…()‍‌]/g, '')
    .trim();
  return CANON.get(t) ?? t;
};

/**
 * One time per CAPTION word, aligned to the recognised words rather than spread
 * evenly across them.
 *
 * Recognition and the transcript disagree in three ways: it mishears, it drops
 * words entirely ("Endodontist" is simply absent — it heard "वह हैं"), and it
 * writes names in the other script. Spreading caption words evenly across the
 * onsets therefore drifts: everything before a dropped word maps to an onset
 * that is too early, which is why the doctors' names and "Endodontist" appeared
 * ahead of the voice.
 *
 * So: match what can be matched (longest common subsequence over normalised
 * tokens), pin those caption words to their real onsets, and interpolate only
 * across the runs that genuinely have no counterpart.
 */
function wordTimeline(a, b, captionText) {
  const dgWords = WORDS.filter((w) => w.start >= a - 0.001 && w.start < b);
  const cap = captionText.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean);
  // An empty result still has to have the SHAPE of a result. Both early exits
  // here used to hand back a bare array, and the caller reads .total off it —
  // so a window with nothing in it and a window nothing matched in were
  // indistinguishable, and both were reported as "the windows are wrong".
  if (!dgWords.length || !cap.length) return { times: [], matched: 0, total: 0 };

  const A = cap.map(norm);
  const B = dgWords.map((w) => norm(w.punctuated_word || w.word));

  // LCS table, then walk it back to get the matched pairs.
  const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      L[i][j] = A[i] && A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const anchor = new Array(cap.length).fill(-1);
  for (let i = 0, j = 0; i < A.length && j < B.length; ) {
    if (A[i] && A[i] === B[j]) { anchor[i] = j; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }

  // Pin the matches; interpolate the gaps between them; extrapolate the ends.
  const times = new Array(cap.length).fill(null);
  for (let i = 0; i < cap.length; i++) if (anchor[i] >= 0) times[i] = dgWords[anchor[i]].start;

  const known = times.map((t, i) => (t === null ? -1 : i)).filter((i) => i >= 0);
  if (!known.length) {
    // Nothing matched, but the window does have speech in it — which is the
    // normal case for a caption in a script the model transcribed in a
    // different one. Telugu comes back from `language=multi` romanised
    // ("Miku", "in Naru"), so not one caption word can anchor even though the
    // timing either side of the line is exact.
    //
    // Spread evenly across the window and say so in the report. The WINDOW is
    // what carries the sync; per-word onsets are a refinement on top of it.
    return {
      times: cap.map((_, i) => +(a + ((b - a) * i) / cap.length).toFixed(2)),
      matched: 0,
      total: cap.length,
    };
  }

  const first = known[0], last = known[known.length - 1];
  for (let i = 0; i < first; i++) {
    times[i] = a + ((times[first] - a) * i) / Math.max(1, first);
  }
  for (let i = last + 1; i < cap.length; i++) {
    times[i] = times[last] + ((b - times[last]) * (i - last)) / Math.max(1, cap.length - last);
  }
  for (let k = 0; k < known.length - 1; k++) {
    const lo = known[k], hi = known[k + 1];
    for (let i = lo + 1; i < hi; i++) {
      times[i] = times[lo] + ((times[hi] - times[lo]) * (i - lo)) / (hi - lo);
    }
  }

  // Never let a word land before the one in front of it.
  for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) times[i] = times[i - 1];

  return { times: times.map((t) => +t.toFixed(2)), matched: known.length, total: cap.length };
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const plainWords = (t) => t.line.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length;

let bad = 0;
console.log('turn  window          caption  anchored  note');
for (const [i, t] of TURNS.entries()) {
  const r = wordTimeline(t.t, t.end, t.line);
  const pct = r.total ? Math.round((r.matched / r.total) * 100) : 0;
  const note = !r.total
    ? '⚠ no words in window'
    : r.matched === 0
      ? 'spread evenly — script not anchorable'
      : pct < 40
        ? '⚠ few anchors — check the window'
        : '';
  if (!r.total) bad++;
  console.log(
    `${String(i).padStart(4)}  ${t.t.toFixed(2)}→${t.end.toFixed(2).padEnd(6)}  ` +
    `${String(r.total).padStart(7)}  ${String(r.matched + ' (' + pct + '%)').padStart(9)}  ${note}`,
  );
}
if (bad) { console.error(`\n✖ ${bad} turn(s) have no recognised words — the windows are wrong.`); process.exit(1); }

console.log('\n── paste into demo-stage.src.html ──────────────────────────\n');
for (const t of TURNS) {
  const times = wordTimeline(t.t, t.end, t.line).times;
  // Every key that is not part of the timing is a stage flag, emitted as-is.
  // This used to be a hardcoded list of ad #1's flags, which meant a second
  // ad's flags were dropped in silence — the cue sheet looked right and the
  // calendar simply never changed state.
  const TIMING = new Set(['t', 'end', 'who', 'phase', 'line', 'gloss', 'wordAt']);
  const flags = Object.keys(t)
    .filter((k) => !TIMING.has(k) && t[k])
    .map((k) => (typeof t[k] === 'string' ? `${k}: '${esc(t[k])}'` : `${k}: true`))
    .join(', ');
  console.log(`    { t: ${t.t.toFixed(2)}, end: ${t.end.toFixed(2)}, phase: '${esc(t.phase)}', who: '${t.who}'${flags ? ', ' + flags : ''},`);
  console.log(`      wordAt: [${times.join(',')}],`);
  console.log(`      line: '${esc(t.line)}'${t.gloss ? ',' : ' },'}`);
  if (t.gloss) console.log(`      gloss: '${esc(t.gloss)}' },`);
}
const OUTRO = CALL.outroAt ?? DURATION;
console.log(`    { t: ${OUTRO.toFixed(2)}, end: ${(OUTRO + 4).toFixed(2)}, phase: '${esc(CALL.outroPhase ?? 'Every call, in writing')}', who: null, outro: true },`);
