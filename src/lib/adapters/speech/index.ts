import type { SpeechProvider } from './types';
import { MockSpeechProvider } from './mock';

let cached: SpeechProvider | null = null;

export function getSpeechProvider(): SpeechProvider {
  if (cached) return cached;
  if (process.env.USE_MOCK_SPEECH !== 'false') {
    cached = new MockSpeechProvider();
    return cached;
  }
  const { GoogleSpeechProvider } = require('./google') as typeof import('./google');
  cached = new GoogleSpeechProvider();
  return cached;
}

export type {
  SpeechProvider,
  SttStream,
  TranscriptResult,
  SynthesizeOptions,
  SynthesizeResult,
} from './types';
