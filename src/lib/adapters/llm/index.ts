import type { LlmProvider } from './types';
import { MockLlmProvider } from './mock';

let cached: LlmProvider | null = null;

// Returns the configured LLM provider. Defaults to the mock unless
// USE_MOCK_LLM=false, in which case the Gemini provider is lazily loaded
// (so the @google/genai SDK + key are only required when actually used).
export function getLlmProvider(): LlmProvider {
  if (cached) return cached;
  if (process.env.USE_MOCK_LLM !== 'false') {
    cached = new MockLlmProvider();
    return cached;
  }
  // Lazy require keeps the mock path free of the real SDK dependency.
  const { GeminiProvider } = require('./gemini') as typeof import('./gemini');
  cached = new GeminiProvider();
  return cached;
}

export type {
  LlmProvider,
  ChatMessage,
  GenerateOptions,
  ToolGenerateOptions,
  ToolHistoryEntry,
  ToolSpec,
  ToolTurn,
} from './types';
