// Per-call model usage accounting for the Gemini Live path.
//
// Why this exists: nothing in the pipeline used to record how many tokens a
// call spent, so the only cost signal was the Google invoice at the end of the
// month — a single number covering every call, with no way to attribute it.
// A measured ₹44.64 for 8.43 minutes of talk time (₹5.29/min) against a retail
// rate of ₹5/min (RATE_PER_MINUTE_INR) is the reason we now count.
//
// The one thing to understand about Live API billing: the model re-processes
// the whole accumulated session window on EVERY turn, so a call's input cost
// grows with the number of turns, not just its length. `usageMetadata` arrives
// once per turn and reports that turn's prompt — summing across turns gives the
// billed total, which is far larger than the final context size. That sum is
// what these fields hold.
//
// Audio and text tokens price ~6x apart, so they are tracked separately;
// pricing one as the other is what makes a naive estimate come out ~20x low.

import { MediaModality, type UsageMetadata, type ModalityTokenCount } from '@google/genai';

export type LiveUsage = {
  /** Number of usageMetadata reports seen — i.e. billed model turns. */
  turns: number;
  /** Sum of per-turn input tokens (prompt + tool-use prompt). */
  promptTokens: number;
  /** Sum of per-turn output tokens (response + thoughts). */
  responseTokens: number;
  /** The audio share of promptTokens. Text input = promptTokens - audioInTokens. */
  audioInTokens: number;
  /** The audio share of responseTokens. Text output = responseTokens - audioOutTokens. */
  audioOutTokens: number;
  /**
   * The last report folded in. Only used to spot an exact repeat — see
   * accumulateUsage. Not persisted; finalize picks the columns it stores.
   */
  last?: { prompt: number; response: number; audioIn: number; audioOut: number };
};

export function emptyUsage(): LiveUsage {
  return { turns: 0, promptTokens: 0, responseTokens: 0, audioInTokens: 0, audioOutTokens: 0 };
}

function audioShare(details: ModalityTokenCount[] | undefined): number {
  if (!details) return 0;
  let n = 0;
  for (const d of details) if (d.modality === MediaModality.AUDIO) n += d.tokenCount ?? 0;
  return n;
}

/**
 * Fold one turn's usageMetadata into the running total. Safe to call with
 * partial or absent detail breakdowns — a missing modality split just leaves
 * the audio share at 0 for that turn (see estimateCostInr for how that is
 * handled when pricing).
 */
export function accumulateUsage(acc: LiveUsage, u: UsageMetadata | undefined): LiveUsage {
  if (!u) return acc;
  // toolUsePromptTokenCount / thoughtsTokenCount are reported separately from
  // prompt/response but are billed as input/output respectively.
  const prompt = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
  const response = (u.responseTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const audioIn = audioShare(u.promptTokensDetails) + audioShare(u.toolUsePromptTokensDetails);
  const audioOut = audioShare(u.responseTokensDetails);

  // "One report per turn" is how Live behaves, not something it promises, and
  // every field here is additive — so one message delivered twice would inflate
  // the whole call silently, with no error to notice. A report identical to the
  // one before it across all four counters is that duplicate: the window grows
  // every turn, so two consecutive REAL turns cannot match on all of them.
  const prev = acc.last;
  if (prev && prev.prompt === prompt && prev.response === response &&
      prev.audioIn === audioIn && prev.audioOut === audioOut) {
    console.warn('[usage] duplicate usageMetadata ignored — prompt:', prompt, 'response:', response);
    return acc;
  }

  acc.turns += 1;
  acc.promptTokens += prompt;
  acc.responseTokens += response;
  acc.audioInTokens += audioIn;
  acc.audioOutTokens += audioOut;
  acc.last = { prompt, response, audioIn, audioOut };
  return acc;
}

// ── Pricing ─────────────────────────────────────────────────────────────────
//
// USD per 1,000,000 tokens. THESE GO STALE — check them against
// https://ai.google.dev/gemini-api/docs/pricing and against a real invoice
// before trusting a margin number built on them. Override without a deploy by
// setting GEMINI_LIVE_RATE_USD to a JSON object of the same shape, e.g.
//   GEMINI_LIVE_RATE_USD='{"native-audio":{"textIn":0.5,"audioIn":3,"textOut":2,"audioOut":12}}'

export type Rate = { textIn: number; audioIn: number; textOut: number; audioOut: number };

// Matched by substring against the model id, first match wins, so order counts.
const DEFAULT_RATES: Array<[string, Rate]> = [
  ['native-audio', { textIn: 0.5, audioIn: 3.0, textOut: 2.0, audioOut: 12.0 }],
  ['2.0-flash-live', { textIn: 0.35, audioIn: 2.1, textOut: 1.5, audioOut: 8.5 }],
  // 3.1 prices text well above 2.5 (in 0.75 vs 0.5, out 4.50 vs 2.00) while
  // charging the same for audio. It has to sit ABOVE the generic flash-live row,
  // which its id also matches — otherwise every 3.1 call is costed as a 2.5 and
  // the system-instruction tokens, which are text and re-billed every turn, come
  // out at less than half what they really cost.
  ['3.1-flash-live', { textIn: 0.75, audioIn: 3.0, textOut: 4.5, audioOut: 12.0 }],
  ['flash-live', { textIn: 0.5, audioIn: 3.0, textOut: 2.0, audioOut: 12.0 }],
];

// What an unrecognised model is priced at. Deliberately the expensive tier: an
// unknown model should over-estimate cost, never flatter it.
const FALLBACK_RATE: Rate = { textIn: 0.5, audioIn: 3.0, textOut: 2.0, audioOut: 12.0 };

function envRates(): Array<[string, Rate]> {
  const raw = process.env.GEMINI_LIVE_RATE_USD;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, Rate>;
    return Object.entries(parsed);
  } catch {
    console.error('[usage] GEMINI_LIVE_RATE_USD is not valid JSON — falling back to built-in rates');
    return [];
  }
}

export function rateForModel(model: string): { rate: Rate; known: boolean } {
  const id = model.toLowerCase();
  for (const [key, rate] of [...envRates(), ...DEFAULT_RATES]) {
    if (id.includes(key.toLowerCase())) return { rate, known: true };
  }
  return { rate: FALLBACK_RATE, known: false };
}

/** Rupees per US dollar. Set USD_INR_RATE to keep invoices reconcilable. */
export function usdInrRate(): number {
  const n = Number(process.env.USD_INR_RATE);
  return Number.isFinite(n) && n > 0 ? n : 88;
}

/**
 * Convert a call's measured token usage into rupees. An estimate, and only as
 * good as the rate table above — but it is derived from measured tokens rather
 * than guessed from wall-clock minutes, which is the whole point.
 *
 * Note the GST caveat when reconciling: a Google invoice in India carries 18%
 * GST on top, so an invoice line will run ~1.18x what this returns.
 */
export function estimateCostInr(usage: LiveUsage, model: string): number {
  const { rate, known } = rateForModel(model);
  if (!known) console.warn('[usage] no rate table entry for model:', model, '— using the expensive-tier fallback');

  // A turn that reported no modality split still cost something. Treating the
  // unsplit remainder as text would under-price it badly on an audio call, so
  // audio is only ever what the API actually attributed to audio, and the rest
  // is priced as text. Where the split is missing entirely this under-reports —
  // the turns/token totals are the fields to trust in that case.
  const textIn = Math.max(0, usage.promptTokens - usage.audioInTokens);
  const textOut = Math.max(0, usage.responseTokens - usage.audioOutTokens);

  const usd =
    (textIn * rate.textIn +
      usage.audioInTokens * rate.audioIn +
      textOut * rate.textOut +
      usage.audioOutTokens * rate.audioOut) /
    1_000_000;

  return Math.round(usd * usdInrRate() * 10_000) / 10_000;
}
