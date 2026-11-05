import { describe, it, expect } from 'vitest';
import {
  languageStyleInstruction,
  LANGUAGE_MODES,
  LANGUAGES,
  MULTILINGUAL_CODES,
  getLanguage,
} from '@/lib/constants';
import { agentInputSchema } from '@/lib/validation';

// languageMode 'multi' exists for the PARÉ enquiry bot: callers ring that line
// from 500+ cities and their number says nothing about what they speak, which
// is all 'auto' can look at. The mode is opt-in, so the thing worth pinning is
// that turning it on for one agent changes NOTHING for the others.

const multi = (lang = 'en-IN') => languageStyleInstruction('multi', lang);

describe('multilingual language mode', () => {
  it('names every configured language, with its native label', () => {
    const text = multi();
    // The five the bot was asked to handle, plus the English it opens in.
    expect(MULTILINGUAL_CODES).toEqual(['en-IN', 'hi-IN', 'mr-IN', 'te-IN', 'ta-IN', 'kn-IN']);
    for (const code of MULTILINGUAL_CODES) {
      if (code === 'en-IN') continue;
      const lang = getLanguage(code)!;
      expect(text).toContain(lang.label);
      expect(text).toContain(lang.nativeLabel);
    }
  });

  it('every code has a voice and a native label to build the instruction from', () => {
    for (const code of MULTILINGUAL_CODES) {
      const lang = LANGUAGES.find((l) => l.code === code);
      expect(lang, `${code} is not in LANGUAGES`).toBeDefined();
      expect(lang!.nativeLabel).toBeTruthy();
      expect(lang!.voices.length).toBeGreaterThan(0);
    }
  });

  it('opens in the configured language and does not list it as a language to switch to', () => {
    const text = multi('en-IN');
    expect(text).toContain('Begin the call in English');
    // "English (English)" — the native label repeats the name for en-IN only.
    expect(text).not.toContain('English (English)');
    // The opening language must not appear in the "switch to these" list.
    const list = text.split('the caller uses: ')[1].split('.')[0];
    expect(list).not.toContain('English');
  });

  it('drops the configured language from the list whichever one it is', () => {
    const text = multi('ta-IN');
    expect(text).toContain('Begin the call in Tamil (தமிழ்)');
    const list = text.split('the caller uses: ')[1].split('.')[0];
    expect(list).toContain('English');
    expect(list).not.toContain('Tamil');
  });

  it('tells the model to follow the caller and never negotiate the language', () => {
    const text = multi();
    expect(text).toContain("Switch on the caller's FIRST reply");
    expect(text).toContain('never ask the caller which language they want');
    // A pincode read as words is unusable to the sales team.
    expect(text).toContain('digits stay digits');
  });

  it('leaves the other three modes byte-for-byte unchanged', () => {
    // Guards the "only for that bot" requirement: these are the strings every
    // OTHER agent on the platform receives.
    expect(languageStyleInstruction('single', 'hi-IN')).toBe(
      '\n\nLanguage: speak entirely in Hindi (हिन्दी). Use a natural, NATIVE Hindi accent, ' +
        'pronunciation, and everyday colloquial phrasing — sound like a local native speaker from India, ' +
        'never like a foreigner speaking Hindi. Do not switch to other languages unless the caller does.',
    );
    expect(languageStyleInstruction('hybrid', 'hi-IN')).toBe(
      '\n\nLanguage: speak in a natural, conversational mix of English and Hindi (हिन्दी) — ' +
        'code-switch the way bilingual speakers in India actually talk on the phone. Use a natural, ' +
        'NATIVE Indian accent and pronunciation — sound like a local speaker, never a foreigner. Keep ' +
        'common English words in English; do not translate everything. Never announce that you are mixing languages.',
    );
    // 'auto' resolves a language up front and then takes the single-language
    // path, so it must render identically to 'single'.
    expect(languageStyleInstruction('auto', 'hi-IN')).toBe(languageStyleInstruction('single', 'hi-IN'));
  });

  it('is offered in the UI and accepted by the agent API', () => {
    expect(LANGUAGE_MODES.map((m) => m.value)).toContain('multi');
    const base = {
      name: 'PARE India Demo',
      systemPrompt: 'You are the front-desk assistant for PARÉ India.',
      language: 'en-IN',
      voice: 'en-IN-Neural2-A',
      direction: 'BOTH' as const,
    };
    expect(agentInputSchema.safeParse({ ...base, languageMode: 'multi' }).success).toBe(true);
    expect(agentInputSchema.safeParse({ ...base, languageMode: 'polyglot' }).success).toBe(false);
  });
});
