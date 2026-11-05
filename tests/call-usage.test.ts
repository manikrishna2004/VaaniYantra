import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MediaModality } from '@google/genai';
import {
  emptyUsage,
  accumulateUsage,
  estimateCostInr,
  rateForModel,
} from '@/lib/voice/usage';

// Per-call token accounting. The pipeline used to record nothing, so a Google
// invoice of ₹44.64 for 8.43 minutes of talk time could not be attributed to
// anything. These pin the two things that made a naive estimate come out ~20x
// low: audio priced as text, and per-turn re-billing of the whole window.

const audio = (n: number) => [{ modality: MediaModality.AUDIO, tokenCount: n }];

describe('accumulateUsage', () => {
  it('sums every turn, because Live bills each turn for the whole window', () => {
    const acc = emptyUsage();
    // A three-turn call whose context grows: the prompt is re-billed in full
    // each time, so the total is 1000+2000+3000, not the final 3000.
    for (const n of [1000, 2000, 3000]) {
      accumulateUsage(acc, {
        promptTokenCount: n,
        responseTokenCount: 200,
        promptTokensDetails: audio(n - 100),
        responseTokensDetails: audio(180),
      });
    }
    expect(acc.turns).toBe(3);
    expect(acc.promptTokens).toBe(6000);
    expect(acc.audioInTokens).toBe(5700);
    expect(acc.responseTokens).toBe(600);
    expect(acc.audioOutTokens).toBe(540);
  });

  it('bills tool-use prompts as input and thoughts as output', () => {
    const acc = emptyUsage();
    accumulateUsage(acc, {
      promptTokenCount: 500,
      toolUsePromptTokenCount: 120,
      responseTokenCount: 80,
      thoughtsTokenCount: 40,
    });
    expect(acc.promptTokens).toBe(620);
    expect(acc.responseTokens).toBe(120);
  });

  it('ignores a turn that reported no usage at all', () => {
    const acc = emptyUsage();
    accumulateUsage(acc, undefined);
    expect(acc).toEqual(emptyUsage());
  });

  it('ignores a report identical to the one before it', () => {
    // Every field here is additive, so one message delivered twice would inflate
    // the whole call with no error to notice. Two consecutive REAL turns cannot
    // match on all four counters — the window grows every turn.
    const acc = emptyUsage();
    const report = {
      promptTokenCount: 1500,
      responseTokenCount: 200,
      promptTokensDetails: audio(1400),
      responseTokensDetails: audio(180),
    };
    accumulateUsage(acc, report);
    accumulateUsage(acc, { ...report });
    expect(acc.turns).toBe(1);
    expect(acc.promptTokens).toBe(1500);
    expect(acc.audioInTokens).toBe(1400);
  });

  it('still counts a repeat that differs in any counter', () => {
    // A revised report for the same turn carries more output than the first.
    // Under-counting is as wrong as over-counting, so only an exact match is
    // treated as a duplicate.
    const acc = emptyUsage();
    accumulateUsage(acc, { promptTokenCount: 1500, responseTokenCount: 200 });
    accumulateUsage(acc, { promptTokenCount: 1500, responseTokenCount: 260 });
    expect(acc.turns).toBe(2);
    expect(acc.responseTokens).toBe(460);
  });
});

describe('estimateCostInr', () => {
  beforeEach(() => {
    process.env.USD_INR_RATE = '88';
  });
  afterEach(() => {
    delete process.env.USD_INR_RATE;
    delete process.env.GEMINI_LIVE_RATE_USD;
  });

  it('prices audio far above text — the reason a text-rate estimate is ~20x low', () => {
    const usage = { ...emptyUsage(), turns: 1, promptTokens: 100_000, audioInTokens: 100_000 };
    const asAudio = estimateCostInr(usage, 'gemini-2.5-flash-native-audio-latest');
    const asText = estimateCostInr(
      { ...usage, audioInTokens: 0 },
      'gemini-2.5-flash-native-audio-latest',
    );
    // 100k tokens: $3.00/M audio vs $0.50/M text.
    expect(asAudio).toBeCloseTo((100_000 * 3.0 * 88) / 1_000_000, 4);
    expect(asAudio / asText).toBeCloseTo(6, 5);
  });

  it('treats the non-audio remainder as text on both sides', () => {
    const usage = {
      turns: 1,
      promptTokens: 10_000,
      audioInTokens: 8_000, // 2k text in
      responseTokens: 5_000,
      audioOutTokens: 4_000, // 1k text out
    };
    const expectedUsd =
      (2_000 * 0.5 + 8_000 * 3.0 + 1_000 * 2.0 + 4_000 * 12.0) / 1_000_000;
    expect(estimateCostInr(usage, 'gemini-2.5-flash-native-audio-latest')).toBeCloseTo(
      expectedUsd * 88,
      4,
    );
  });

  it('prices gemini-3.1 on its own row, not the generic flash-live one', () => {
    // Its id matches BOTH '3.1-flash-live' and 'flash-live', and first match
    // wins — so the order of the table is what stops 3.1's text being costed at
    // 2.5's rates. That matters because the system instruction is text and is
    // re-billed on every turn: getting it wrong halves the number that the whole
    // optimisation is measured against.
    const { known, rate } = rateForModel('gemini-3.1-flash-live-preview');
    expect(known).toBe(true);
    expect(rate.textIn).toBe(0.75);
    expect(rate.textOut).toBe(4.5);
    expect(rate.audioIn).toBe(3.0); // audio is the same; the model is not a cost lever
    expect(rate.audioOut).toBe(12.0);
  });

  it('still prices an older flash-live model on the generic row', () => {
    expect(rateForModel('gemini-live-2.5-flash-preview').rate.textOut).toBe(2.0);
  });

  it('falls back to the expensive tier for an unknown model rather than flattering it', () => {
    const { known, rate } = rateForModel('some-unreleased-model');
    expect(known).toBe(false);
    expect(rate.audioOut).toBe(12.0);
  });

  it('lets GEMINI_LIVE_RATE_USD override a rate without a deploy', () => {
    process.env.GEMINI_LIVE_RATE_USD = JSON.stringify({
      'native-audio': { textIn: 1, audioIn: 1, textOut: 1, audioOut: 1 },
    });
    const usage = { ...emptyUsage(), turns: 1, promptTokens: 1_000_000, audioInTokens: 1_000_000 };
    expect(estimateCostInr(usage, 'gemini-2.5-flash-native-audio-latest')).toBeCloseTo(88, 4);
  });

  it('ignores malformed rate JSON instead of throwing mid-call', () => {
    process.env.GEMINI_LIVE_RATE_USD = 'not json';
    const usage = { ...emptyUsage(), turns: 1, promptTokens: 1_000_000, audioInTokens: 1_000_000 };
    expect(estimateCostInr(usage, 'gemini-2.5-flash-native-audio-latest')).toBeCloseTo(3 * 88, 4);
  });
});
