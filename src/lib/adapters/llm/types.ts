// LLM adapter — the agent "brain" that turns caller speech into replies.
// The realtime voice pipeline streams tokens so TTS can start speaking before
// the full reply is generated (lower perceived latency).

export type ChatRole = 'user' | 'model';

export type ChatMessage = {
  role: ChatRole;
  text: string;
};

// A function declaration offered to the model, in the Gemini REST shape. Kept
// structurally identical to ToolDeclaration in src/lib/connectors/tools.ts so
// the same connector tools can be handed to either the realtime voice pipeline
// or the text chat path without translation.
export type ToolSpec = {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

// One round of the tool loop: either the model produced an answer, or it wants
// tools run first. Both can be present — Gemini sometimes narrates ("let me
// check…") alongside a call — so callers should prefer `calls` when non-empty.
export type ToolTurn = {
  text: string;
  calls: { name: string; args: Record<string, unknown> }[];
};

// A tool result fed back to the model on the next round.
export type ToolResultMessage = {
  role: 'tool';
  name: string;
  response: Record<string, unknown>;
};

// The transcript the tool loop replays each round: plain turns interleaved with
// the calls the model made and what they returned.
export type ToolHistoryEntry = ChatMessage | { role: 'call'; name: string; args: Record<string, unknown> } | ToolResultMessage;

export type GenerateOptions = {
  // The agent's behavior prompt + retrieved knowledge, injected as the system
  // instruction.
  systemInstruction: string;
  // Conversation so far (oldest first). The latest caller utterance is the
  // last entry with role "user".
  history: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  // BCP-47 language to nudge the model to respond in (e.g. "hi-IN").
  languageCode?: string;
};

export type ToolGenerateOptions = Omit<GenerateOptions, 'history'> & {
  history: ToolHistoryEntry[];
  tools: ToolSpec[];
};

export interface LlmProvider {
  readonly name: string;
  // Single-shot generation (used for summaries, non-realtime paths).
  generate(opts: GenerateOptions): Promise<string>;
  // Streaming generation — yields text deltas as they arrive.
  stream(opts: GenerateOptions): AsyncIterable<string>;
  // One round of a tool-calling conversation. Unlike the realtime pipeline
  // (where Gemini Live owns the loop), the caller drives: run the returned
  // calls, append their results to `history`, and call again until `calls` is
  // empty. Used by the patient portal chat.
  generateWithTools(opts: ToolGenerateOptions): Promise<ToolTurn>;
}
