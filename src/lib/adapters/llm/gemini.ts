import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';
import { getLanguage } from '@/lib/constants';
import { getGeminiApiKey, getGeminiModel } from '@/lib/platform';
import type { GenerateOptions, LlmProvider, ToolGenerateOptions, ToolTurn } from './types';

// Google Gemini 2.5 Flash — chosen for the realtime voice loop because it has
// low latency and strong multilingual (incl. Indian language) support, and
// keeps the stack in the Google ecosystem alongside Cloud Speech.
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI | null = null;
  private clientKey: string | undefined;
  private model: string;

  constructor() {
    this.model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }

  // Resolve the effective key (platform secret > env) and (re)build the client
  // when it changes, so a key rotated from the admin dashboard takes effect.
  private async getClient(): Promise<GoogleGenAI> {
    const key = await getGeminiApiKey();
    if (!key) throw new Error('No Gemini API key configured (set one in the admin dashboard or env).');
    if (!this.client || key !== this.clientKey) {
      this.client = new GoogleGenAI({ apiKey: key });
      this.clientKey = key;
    }
    this.model = await getGeminiModel(); // admin-tunable (DB > env)
    return this.client;
  }

  private buildSystemInstruction(opts: GenerateOptions): string {
    const lang = opts.languageCode ? getLanguage(opts.languageCode) : undefined;
    const langLine = lang
      ? `\n\nAlways respond in ${lang.label} (${lang.nativeLabel}). Match the caller's language if they switch.`
      : '';
    return opts.systemInstruction + langLine;
  }

  private buildContents(opts: GenerateOptions) {
    return opts.history.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    }));
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const client = await this.getClient();
    const response = await client.models.generateContent({
      model: this.model,
      contents: this.buildContents(opts),
      config: {
        systemInstruction: this.buildSystemInstruction(opts),
        temperature: opts.temperature ?? 0.6,
        maxOutputTokens: opts.maxOutputTokens ?? 512,
        // Disable Gemini 2.5 "thinking" — it adds several seconds before the
        // first token, which is unacceptable for a live voice call.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return response.text ?? '';
  }

  // One round of a tool-calling exchange. The caller owns the loop (see
  // ToolGenerateOptions) because the tools here touch the real calendar and
  // patient records — a bounded, inspectable loop beats an autonomous one.
  async generateWithTools(opts: ToolGenerateOptions): Promise<ToolTurn> {
    const client = await this.getClient();
    const response = await client.models.generateContent({
      model: this.model,
      contents: opts.history.map((m) => {
        if (m.role === 'call') {
          return { role: 'model', parts: [{ functionCall: { name: m.name, args: m.args } }] };
        }
        if (m.role === 'tool') {
          // Gemini expects tool results on the "user" side of the transcript.
          return { role: 'user', parts: [{ functionResponse: { name: m.name, response: m.response } }] };
        }
        return { role: m.role, parts: [{ text: m.text }] };
      }),
      config: {
        systemInstruction: this.buildSystemInstruction(opts as GenerateOptions),
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxOutputTokens ?? 700,
        // ToolSpec spells the JSON-schema types as plain strings ("OBJECT",
        // "STRING"); the SDK types them as its `Type` enum, whose members are
        // those very strings. The wire format is identical, so this cast is a
        // nominal-typing formality — same trick the realtime path uses in
        // src/lib/voice/live.ts.
        tools: [{ functionDeclarations: opts.tools as unknown as FunctionDeclaration[] }],
        // Thinking stays off for the same latency reason as the voice path;
        // a patient waiting on a chat reply is no more patient than a caller.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const calls = (response.functionCalls ?? []).map((c) => ({
      name: c.name ?? '',
      args: (c.args ?? {}) as Record<string, unknown>,
    }));
    return { text: response.text ?? '', calls: calls.filter((c) => c.name) };
  }

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const client = await this.getClient();
    const stream = await client.models.generateContentStream({
      model: this.model,
      contents: this.buildContents(opts),
      config: {
        systemInstruction: this.buildSystemInstruction(opts),
        temperature: opts.temperature ?? 0.6,
        maxOutputTokens: opts.maxOutputTokens ?? 512,
        // Disable thinking for low-latency first-token (see above).
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  }
}
