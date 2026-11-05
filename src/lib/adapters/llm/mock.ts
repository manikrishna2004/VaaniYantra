import type { GenerateOptions, LlmProvider, ToolGenerateOptions, ToolTurn } from './types';

// Deterministic, offline stand-in for Gemini. Produces plausible, short,
// phone-appropriate replies so the whole pipeline can be exercised without an
// API key. Swap to GeminiProvider by setting USE_MOCK_LLM=false + GEMINI_API_KEY.
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock-llm';

  private reply(opts: GenerateOptions): string {
    const lastUser = [...opts.history].reverse().find((m) => m.role === 'user');
    const q = (lastUser?.text ?? '').toLowerCase();

    // Pull a hint of the knowledge base if it was injected into the system
    // instruction (the RAG layer appends a "Knowledge:" block).
    const kbMatch = opts.systemInstruction.match(/Knowledge:\n([\s\S]*)$/);
    const kb = kbMatch?.[1]?.trim();

    // The patient portal injects the contact's own visit history under this
    // heading; without it the mock would answer "what did the doctor give me?"
    // from the clinic FAQ, which reads as broken during local testing.
    const recordMatch = opts.systemInstruction.match(/Patient record:\n([\s\S]*?)(?:\n\n[A-Z]|$)/);
    const record = recordMatch?.[1]?.trim();

    if (!lastUser) {
      return "Hello! Thanks for calling. How can I help you today?";
    }
    if (record && /(prescri|medicine|medication|tablet|dosage|dose|doctor said|advice|report|visit|last time)/.test(q)) {
      return `From your visit records: ${truncate(record, 300)}`;
    }
    if (/(hi|hello|hey|namaste|vanakkam)\b/.test(q)) {
      return 'Hi there! How can I help you today?';
    }
    if (/(price|cost|how much|charge|fee)/.test(q)) {
      return kb
        ? `Based on our information: ${truncate(kb, 180)}. Would you like more detail?`
        : 'Our pricing depends on the plan you choose. Would you like me to walk you through the options?';
    }
    if (/(hour|open|timing|when)/.test(q)) {
      return 'We are open Monday to Saturday, 9 AM to 7 PM. Is there anything else I can help with?';
    }
    if (/(bye|thank|thanks|that's all|nothing)/.test(q)) {
      return 'Thank you for calling! Have a great day.';
    }
    if (kb) {
      return `Here's what I found: ${truncate(kb, 200)}. Does that answer your question?`;
    }
    return `I understand you're asking about "${truncate(lastUser.text, 60)}". Let me help with that. Could you tell me a bit more?`;
  }

  async generate(opts: GenerateOptions): Promise<string> {
    return this.reply(opts);
  }

  // The mock never calls tools — it answers straight from the injected context.
  // That keeps offline runs deterministic and stops the portal's booking tools
  // (which hit a real calendar) from firing without an API key.
  async generateWithTools(opts: ToolGenerateOptions): Promise<ToolTurn> {
    const plain = opts.history.filter((m) => m.role === 'user' || m.role === 'model');
    return { text: this.reply({ ...opts, history: plain as GenerateOptions['history'] }), calls: [] };
  }

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const text = this.reply(opts);
    // Emit word-by-word to mimic token streaming for the realtime pipeline.
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 18));
      yield (i === 0 ? '' : ' ') + words[i];
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}
