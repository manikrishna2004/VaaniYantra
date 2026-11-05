// Deterministic emergency detection for the patient chatbot.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A PROMPT
// The chatbot's system instruction already tells the model to send anyone
// describing a worsening problem to the clinic. That is an instruction, not a
// control: it is advisory, it competes with every other instruction in a long
// prompt, and it fails exactly when the model is being helpful and reassuring —
// which is the failure that matters. "I've had chest pain since this morning"
// typed at 2am must not depend on a language model's judgement.
//
// So this runs BEFORE the model, on every inbound message, and short-circuits
// the whole pipeline.
//
// DELIBERATELY NOT CUSTOMER-EDITABLE. A clinic that can edit its own emergency
// list can empty it, and then a missed emergency is our liability with their
// fingerprints on it. If a clinic needs a term added, it goes through a
// clinician and a release.
//
// TUNED FOR RECALL, NOT PRECISION. The asymmetry is not close: a false positive
// costs one turn and ten seconds of mild annoyance, and the patient simply sends
// their message again. A false negative is a person having a heart attack being
// told their antibiotic is fine to take after food. We accept a low precision
// floor and tune down from evidence, never up from anxiety.
//
// THIS IS A FLOOR, NOT A NET. It catches unambiguous cases deterministically and
// for free. Everything else still reaches the model, which still carries its own
// urgent-care instruction.

export type RedFlag = {
  /** Which concept fired — for logs and the clinic's alert, never shown to the patient. */
  concept: RedFlagConcept;
  /** The matched pattern, for tuning. */
  matched: string;
};

export type RedFlagConcept =
  | 'chest_pain'
  | 'breathlessness'
  | 'severe_bleeding'
  | 'overdose'
  | 'self_harm'
  | 'unconscious'
  | 'stroke';

/**
 * Normalise a message for matching.
 *
 * NFKD then strip combining marks folds Devanagari matras and Latin diacritics;
 * collapsing runs of a repeated character catches "chesttt" and "dardddd";
 * punctuation becomes whitespace so "chest-pain" and "chest.pain" tokenise.
 *
 * Everything downstream matches whole TOKENS against this, never substrings —
 * a substring match on "bp" fires inside "bpo", and on "sos" inside "sosa".
 */
export function normalize(text: string): string[] {
  return normalizeString(text).split(/\s+/).filter(Boolean);
}

/**
 * The shared normalisation, applied to BOTH the message and the patterns.
 *
 * Both sides must go through the identical transform or a Devanagari pattern
 * written in this file may not equal the same word arriving from a phone
 * keyboard — the two can be canonically equivalent yet differently encoded.
 *
 * `̀-ͯ` is the Latin combining-diacritic block that NFKD produces for
 * accented characters. It deliberately does NOT cover Devanagari matras
 * (`ऀ`+), which carry meaning and must survive.
 */
function normalizeString(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // Latin diacritics, post-decomposition
    .replace(/[​-‍﻿]/g, '') // zero-width joiners / BOM
    .toLowerCase()
    .replace(/(.)\1{2,}/g, '$1$1') // "chesttt" -> "chestt"
    // \p{M} is essential: Devanagari matras (ी, ें, ्) are Marks, not Letters,
    // so a class of only \p{L}\p{N} shreds "सीने" into "स" + "न".
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ');
}

/**
 * The consonant skeleton of a token — the technique that makes transliterated
 * Hinglish tractable.
 *
 * The hard part of Indian-language matching is not the number of languages, it
 * is that ONE spoken phrase has a dozen written forms: saans / sans / saanse /
 * saans, nahi / nhi / nahin. Dropping vowels collapses all of them onto one
 * pattern — every variant of "saans" reduces to "sns" — which takes the list per
 * language from unmaintainable to a few dozen entries.
 *
 * Applied to Latin script only. Devanagari is matched literally, where spelling
 * is already stable.
 */
export function skeleton(token: string): string {
  if (!/^[a-z]+$/.test(token)) return token;
  // Drop vowels, then fold doubled consonants: transliteration doubles them
  // freely ("saanss", "chesttt" → "chestt"), and a doubled consonant never
  // distinguishes two words we care about.
  const bones = token.replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');
  // A word that is all vowels ("aa", "ooo") has no skeleton worth matching.
  return bones.length >= 2 ? bones : token;
}

/** A single pattern term, run through the same pipeline as the message. */
function normalizeTerm(term: string): string {
  return normalizeString(term).trim();
}

type Pattern = {
  concept: RedFlagConcept;
  /**
   * All must be present somewhere in the message. Latin entries are matched on
   * the consonant skeleton, Devanagari literally. Single-token patterns are
   * only used where the token is unambiguous on its own.
   */
  all: string[];
};

// English + Hindi (Devanagari AND Latin transliteration, which the skeleton
// match folds into one). Deliberately two languages done properly rather than
// twenty done badly — every addition needs clinician review, because a wrong
// entry here is either alert fatigue or a missed emergency.
const PATTERNS: Pattern[] = [
  // ── Chest pain ────────────────────────────────────────────────────────────
  { concept: 'chest_pain', all: ['chest', 'pain'] },
  { concept: 'chest_pain', all: ['chest', 'tightness'] },
  { concept: 'chest_pain', all: ['chest', 'pressure'] },
  { concept: 'chest_pain', all: ['heart', 'attack'] },
  { concept: 'chest_pain', all: ['seene', 'dard'] }, // seene mein dard
  { concept: 'chest_pain', all: ['chhati', 'dard'] },
  { concept: 'chest_pain', all: ['सीने', 'दर्द'] },
  { concept: 'chest_pain', all: ['छाती', 'दर्द'] },

  // ── Breathlessness ────────────────────────────────────────────────────────
  { concept: 'breathlessness', all: ['cant', 'breathe'] },
  { concept: 'breathlessness', all: ['cannot', 'breathe'] },
  { concept: 'breathlessness', all: ['trouble', 'breathing'] },
  { concept: 'breathlessness', all: ['difficulty', 'breathing'] },
  { concept: 'breathlessness', all: ['breathless'] },
  { concept: 'breathlessness', all: ['suffocating'] },
  { concept: 'breathlessness', all: ['saans', 'nahi'] }, // saans nahi aa rahi
  { concept: 'breathlessness', all: ['saans', 'phool'] }, // saanse phool rahi
  { concept: 'breathlessness', all: ['dam', 'ghut'] }, // dam ghut raha hai
  { concept: 'breathlessness', all: ['सांस', 'नहीं'] },
  { concept: 'breathlessness', all: ['साँस', 'नहीं'] },

  // ── Severe bleeding ───────────────────────────────────────────────────────
  { concept: 'severe_bleeding', all: ['heavy', 'bleeding'] },
  { concept: 'severe_bleeding', all: ['severe', 'bleeding'] },
  { concept: 'severe_bleeding', all: ['bleeding', 'stop'] }, // bleeding won't stop
  { concept: 'severe_bleeding', all: ['vomiting', 'blood'] },
  { concept: 'severe_bleeding', all: ['coughing', 'blood'] },
  { concept: 'severe_bleeding', all: ['bahut', 'khoon'] },
  { concept: 'severe_bleeding', all: ['khoon', 'band'] }, // khoon band nahi ho raha
  { concept: 'severe_bleeding', all: ['बहुत', 'खून'] },

  // ── Overdose / poisoning ──────────────────────────────────────────────────
  { concept: 'overdose', all: ['overdose'] },
  { concept: 'overdose', all: ['too', 'many', 'tablets'] },
  { concept: 'overdose', all: ['too', 'many', 'pills'] },
  { concept: 'overdose', all: ['extra', 'tablets'] },
  { concept: 'overdose', all: ['swallowed', 'poison'] },
  { concept: 'overdose', all: ['zyada', 'goli'] }, // zyada goli kha li
  { concept: 'overdose', all: ['ज्यादा', 'गोली'] },

  // ── Self-harm ─────────────────────────────────────────────────────────────
  { concept: 'self_harm', all: ['suicide'] },
  { concept: 'self_harm', all: ['suicidal'] },
  { concept: 'self_harm', all: ['kill', 'myself'] },
  { concept: 'self_harm', all: ['end', 'my', 'life'] },
  { concept: 'self_harm', all: ['harm', 'myself'] },
  { concept: 'self_harm', all: ['aatmahatya'] },
  { concept: 'self_harm', all: ['आत्महत्या'] },

  // ── Unconsciousness ───────────────────────────────────────────────────────
  { concept: 'unconscious', all: ['unconscious'] },
  { concept: 'unconscious', all: ['fainted'] },
  { concept: 'unconscious', all: ['not', 'responding'] },
  { concept: 'unconscious', all: ['behosh'] },
  { concept: 'unconscious', all: ['बेहोश'] },

  // ── Stroke ────────────────────────────────────────────────────────────────
  { concept: 'stroke', all: ['face', 'drooping'] },
  { concept: 'stroke', all: ['slurred', 'speech'] },
  { concept: 'stroke', all: ['stroke'] },
  { concept: 'stroke', all: ['paralysis'] },
  { concept: 'stroke', all: ['lakwa'] },
  { concept: 'stroke', all: ['लकवा'] },
];

/**
 * Words that cancel a match when they appear shortly before it.
 *
 * This kills the single most common false positive by a wide margin: "no chest
 * pain now", "I don't have chest pain".
 *
 * DELIBERATELY NOT extended to tense or third parties. "My father has chest
 * pain" is still an emergency — arguably more so, because the person typing is
 * not the patient — and reliable tense detection across transliterated Hinglish
 * does not exist. Suppressing on "was" or "yesterday" would trade a rare false
 * positive for a class of false negatives.
 */
const NEGATIONS = new Set(
  ['no', 'not', 'never', 'without', 'nahi', 'nhi', 'nahin', 'bina', 'नहीं', 'बिना'].map(normalizeTerm),
);
const NEGATION_WINDOW = 3;

/**
 * Patterns with every term pre-normalised at module load, so matching never
 * compares a raw source literal against a normalised message token.
 */
const COMPILED: Pattern[] = PATTERNS.map((p) => ({
  concept: p.concept,
  all: p.all.map(normalizeTerm),
}));

/**
 * Scan a patient message for an unambiguous emergency.
 *
 * Pure and synchronous — no I/O, no model call — so it stays usable on the
 * degraded path where the database is unreachable.
 */
export function detectRedFlag(text: string): RedFlag | null {
  const tokens = normalize(text);
  if (tokens.length === 0) return null;

  const bones = tokens.map(skeleton);

  // Positions of every negation, so a match can be tested against them.
  const negationsAt: number[] = [];
  tokens.forEach((t, i) => {
    if (NEGATIONS.has(t)) negationsAt.push(i);
  });

  for (const pattern of COMPILED) {
    const hits = pattern.all.map((needle) => indexOfNeedle(tokens, bones, needle));
    if (hits.some((i) => i === -1)) continue;

    // A pattern that CONTAINS a negation word is never suppressed by one.
    //
    // Hindi puts the negation inside the emergency phrase: "saans nahi aa rahi"
    // ("breath isn't coming") IS the symptom. Treating its own "nahi" as a
    // denial would suppress the very phrase we most need to catch. So for these
    // patterns we accept that a genuine Hindi denial also fires — one wasted
    // turn against a missed breathlessness report is not a close call.
    const selfNegating = pattern.all.some((t) => NEGATIONS.has(t));
    if (!selfNegating) {
      // Negated when a denial sits just before the earliest matched term, which
      // is what kills "no chest pain now".
      const first = Math.min(...hits);
      const negated = negationsAt.some((n) => n < first && first - n <= NEGATION_WINDOW);
      if (negated) continue;
    }

    return { concept: pattern.concept, matched: pattern.all.join(' ') };
  }

  return null;
}

/**
 * Where a pattern term appears, or -1.
 *
 * Latin terms match on the consonant skeleton so spelling variants collapse;
 * non-Latin terms match the token literally.
 */
function indexOfNeedle(tokens: string[], bones: string[], needle: string): number {
  const isLatin = /^[a-z]+$/.test(needle);
  if (!isLatin) return tokens.indexOf(needle);
  const target = skeleton(needle);
  return bones.indexOf(target);
}

// ── The reply ───────────────────────────────────────────────────────────────
//
// Written so that receiving it unnecessarily is harmless. NOT "you may be having
// a heart attack" — a false positive must not frighten someone asking whether
// their tablet causes chest pain. It states the emergency numbers, says plainly
// that a chat window is the wrong channel, and points at the clinic.
//
// A small table rather than a model call: translating this through the model
// would reinstate exactly the dependency the tripwire exists to remove. The
// digits survive every language regardless.

const REPLIES: Record<string, (clinic: string) => string> = {
  'hi-IN': (clinic) =>
    `अगर यह आपात स्थिति है तो अभी 108 (एम्बुलेंस) या 112 पर कॉल करें।\n\n` +
    `मैं चैट पर तुरंत ज़रूरी लक्षणों में मदद नहीं कर सकता।\n\n` +
    `कृपया सीधे ${clinic} को फ़ोन करें।`,
};

const REPLY_EN = (clinic: string) =>
  `If this is an emergency, call 108 (ambulance) or 112 right now.\n\n` +
  `I can't help with urgent symptoms over chat.\n\n` +
  `Please call ${clinic} directly, or go to your nearest emergency department.`;

/** The canned reply, in the agent's language where we have one. */
export function emergencyReply(clinicName: string, language?: string | null): string {
  const localized = language ? REPLIES[language] : undefined;
  return (localized ?? REPLY_EN)(clinicName || 'the clinic');
}

// ── The spoken reply ────────────────────────────────────────────────────────
//
// Same policy as above, rewritten for a phone call rather than a chat window:
//
//  - No line breaks. These strings go through TTS, which reads punctuation as
//    pauses and newlines as nothing at all.
//  - "Hang up and call" rather than "call": the caller is ALREADY on a phone,
//    and the single most useful instruction is to free the line and dial.
//  - The action comes first. A caller in distress may not hear the end of the
//    sentence, so the emergency number must not be at the end of it.

const SPOKEN_REPLIES: Record<string, (clinic: string) => string> = {
  'hi-IN': (clinic) =>
    `अगर यह आपात स्थिति है, तो कृपया अभी फ़ोन रखें और 108 पर एम्बुलेंस के लिए कॉल करें, या 112 पर। ` +
    `मैं फ़ोन पर ज़रूरी लक्षणों में मदद नहीं कर सकता। ` +
    `ज़रूरत हो तो ${clinic} को सीधे फ़ोन करें, या नज़दीकी अस्पताल जाएँ।`,
};

const SPOKEN_EN = (clinic: string) =>
  `If this is a medical emergency, please hang up now and call 108 for an ambulance, or 112. ` +
  `I can't help with urgent symptoms over the phone. ` +
  `If you need to, call ${clinic} directly, or go to your nearest emergency department.`;

/** The canned reply as it should be SPOKEN on a call. */
export function emergencySpokenReply(clinicName: string, language?: string | null): string {
  const localized = language ? SPOKEN_REPLIES[language] : undefined;
  return (localized ?? SPOKEN_EN)(clinicName || 'the clinic');
}

/** Human-readable concept, for the clinic's alert. */
export const CONCEPT_LABELS: Record<RedFlagConcept, string> = {
  chest_pain: 'chest pain',
  breathlessness: 'breathlessness',
  severe_bleeding: 'severe bleeding',
  overdose: 'possible overdose',
  self_harm: 'self-harm',
  unconscious: 'unconsciousness',
  stroke: 'possible stroke',
};
