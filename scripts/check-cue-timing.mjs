/**
 * Print when each caption word appears, so the streaming can be checked without
 * playing the audio back and eyeballing it.
 *
 *   node scripts/check-cue-timing.mjs                          # ad #1, summary
 *   node scripts/check-cue-timing.mjs --variant reschedule     # ad #2
 *   node scripts/check-cue-timing.mjs 0 5 11                   # word-by-word for those cues
 *
 * Reads the CUES array straight out of the page and replays the same maths the
 * page uses, so a discrepancy here is a real one.
 *
 * This used to read a `segs` field and pace by speaking time. That schema is
 * gone — cues carry `wordAt`, one real onset per caption word — and the script
 * had been silently failing every cue ever since. It also carried its own copy
 * of the caption lead, which drifted from the page's by 0.4s. Both values are
 * now read out of the page itself: there is no second place to keep in step.
 */
import { readFileSync } from 'node:fs';

const vAt = process.argv.indexOf('--variant');
const VARIANT = vAt > -1 && process.argv[vAt + 1] ? process.argv[vAt + 1] : '';
const SRC = `sales/demo-stage${VARIANT ? `-${VARIANT}` : ''}.src.html`;

const s = readFileSync(SRC, 'utf8');
const open = s.indexOf('[', s.indexOf('const CUES = ['));
const close = s.indexOf('\n  ];', open);
if (open < 0 || close < 0) { console.error(`✖ no CUES array in ${SRC}`); process.exit(1); }
const CUES = eval(s.slice(open, close) + '\n]');

// The page's own defaults, so this can never disagree with what is on screen.
const num = (re, fallback) => { const m = s.match(re); return m ? Number(m[1]) : fallback; };
const LEAD = num(/let capLead = ([\d.]+);/, 0.05);
const SPEED = num(/let wordSpeed = ([\d.]+);/, 0.85);

// Ad #2 raises the speed per cue so a line cannot still be arriving when the
// next one replaces it. Ad #1 has no such floor and genuinely loses the tails of
// some lines. Detect which page this is rather than assuming — reporting a floor
// that isn't in the page would be worse than reporting nothing.
const HAS_FLOOR = s.includes('const deadline = nextT - 0.15;');

const wordsOf = (c) => (c.line || '').replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean);

// Exactly what streamWords() does: a word is up once its own time is reached,
// with the line stretched around its start by the speed knob.
// The page raises the speed for a cue that would otherwise still be arriving
// when the next one replaces it. Mirror that, or this disagrees with the screen.
const speedFor = (c, next) => {
  if (!HAS_FLOOR || !c.wordAt || !c.wordAt.length || !next) return SPEED;
  const deadline = next.t - 0.15;
  if (deadline + LEAD <= c.t) return SPEED;
  return Math.max(SPEED, (c.wordAt[c.wordAt.length - 1] - c.t) / (deadline + LEAD - c.t));
};

const shownAt = (c, time, sp = SPEED) => {
  const eff = c.t + (time + LEAD - c.t) * sp;
  let n = 0;
  while (n < c.wordAt.length && c.wordAt[n] <= eff) n++;
  return n;
};

function appearances(c, next) {
  const sp = speedFor(c, next);
  const words = wordsOf(c);
  const out = [];
  let last = 0;
  for (let t = c.t - LEAD; t <= c.end + 0.5 && last < words.length; t += 0.02) {
    const n = Math.min(words.length, shownAt(c, t, sp));
    while (last < n) out.push([t, words[last++]]);
  }
  while (last < words.length) out.push([c.end, words[last++]]);
  return out;
}

const want = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n));

console.log(`${SRC}\ncues: ${CUES.length}   lead: ${LEAD}s   speed: ${SPEED}×\n`);

let worst = 0;
const problems = [];
const notes = [];
const truncated = [];
let prev = null;

CUES.forEach((c, i) => {
  if (!c.line) return;
  const words = wordsOf(c);
  const span = c.end - c.t;
  const rate = span / words.length;
  worst = Math.max(worst, rate);

  // Structural checks — these are bugs, not judgement calls.
  if (c.end <= c.t) problems.push(`cue ${i}: ends (${c.end}) at or before it starts (${c.t})`);

  // The one that matters most: streamWords() only uses wordAt when its length
  // matches the caption exactly, and otherwise falls back to an even spread
  // without saying so. An edited line with stale times looks fine and is wrong.
  if (!c.wordAt) {
    problems.push(`cue ${i}: no wordAt — the page will spread this line evenly`);
  } else if (c.wordAt.length !== words.length) {
    problems.push(
      `cue ${i}: ${c.wordAt.length} times for ${words.length} caption words — ` +
      'the page will silently fall back to an even spread. Re-run align-cues.',
    );
  } else {
    for (let k = 1; k < c.wordAt.length; k++) {
      if (c.wordAt[k] < c.wordAt[k - 1]) {
        problems.push(`cue ${i}: word ${k} (${c.wordAt[k]}) lands before word ${k - 1} (${c.wordAt[k - 1]})`);
        break;
      }
    }
    if (c.wordAt[0] < c.t - 0.01) problems.push(`cue ${i}: first word (${c.wordAt[0]}) precedes the window (${c.t})`);
    const lastAt = c.wordAt[c.wordAt.length - 1];
    if (lastAt > c.end + 0.01) problems.push(`cue ${i}: last word (${lastAt}) overruns the window (${c.end})`);
  }

  // Does the line actually finish before it is taken off screen? This is the
  // one the eye catches and the numbers above do not: a caption can be paced
  // perfectly and still lose its last three words to the next cue.
  const next = CUES[i + 1];
  if (c.wordAt && c.wordAt.length === words.length && next) {
    const sp = speedFor(c, next);
    const landsAt = c.t + (c.wordAt[c.wordAt.length - 1] - c.t) / sp - LEAD;
    if (landsAt > next.t + 0.001) {
      (HAS_FLOOR ? problems : truncated).push(
        `cue ${i}: last word lands at ${landsAt.toFixed(2)}, but cue ${i + 1} replaces it ` +
        `at ${next.t.toFixed(2)} — the end of the line never appears`,
      );
    } else if (sp > SPEED + 0.001) {
      notes.push(`cue ${i} runs at ${sp.toFixed(2)}× (not ${SPEED}×) so it lands before cue ${i + 1}`);
    }
  }

  // Overlapping windows are legitimate when someone interrupts, and a mistake
  // when one speaker appears to talk over themselves.
  if (prev && c.t < prev.end) {
    const how = `cue ${i} starts (${c.t.toFixed(2)}) before cue ${prev.i} ends (${prev.end.toFixed(2)})`;
    if (c.who && prev.who && c.who !== prev.who) notes.push(`${how} — ${prev.who} → ${c.who}, an interruption`);
    else problems.push(`${how} — same speaker, so one window is wrong`);
  }
  prev = { i, end: c.end, who: c.who };

  const flag = rate > 1.2 ? '  ⚠ slow' : rate < 0.12 ? '  ⚠ fast' : '';
  console.log(
    `${String(i).padStart(2)}  ${c.t.toFixed(2)}→${c.end.toFixed(2)}  ` +
    `${String(words.length).padStart(3)}w  ${span.toFixed(2)}s  ` +
    `${rate.toFixed(2)}s/word${flag}`,
  );
});

console.log(`\nslowest line: ${worst.toFixed(2)}s per word`);

if (notes.length) {
  console.log(`\n· ${notes.length} note(s):`);
  for (const n of notes) console.log(`  ${n}`);
}

if (truncated.length) {
  console.warn(
    `\n⚠ ${truncated.length} line(s) lose their tail. This page has no per-cue speed` +
    ` floor, so wordSpeed ${SPEED}× keeps running past the moment the next cue lands:`,
  );
  for (const t of truncated) console.warn(`  ${t}`);
}

if (problems.length) {
  console.error(`\n✖ ${problems.length} structural problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('✓ every cue is ordered, non-empty, and has one real word time per caption word');

for (const i of want) {
  const c = CUES[i];
  if (!c || !c.line) continue;
  console.log(`\n── cue ${i} · ${c.phase} ─────────────────────────`);
  for (const [t, w] of appearances(c, CUES[i + 1])) console.log(`  ${t.toFixed(2)}s  ${w}`);
}
