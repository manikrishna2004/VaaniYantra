import type {
  SpeechProvider,
  SttStream,
  SynthesizeOptions,
  SynthesizeResult,
  TranscriptResult,
} from './types';

// Offline stand-in for Google Cloud Speech. STT echoes any text frames pushed
// to it (the mock telephony layer sends caller text as UTF-8 "audio"), and TTS
// returns a tiny placeholder buffer. Lets the full pipeline run with no keys.
export class MockSpeechProvider implements SpeechProvider {
  readonly name = 'mock-speech';

  async transcribe(audio: Buffer): Promise<TranscriptResult> {
    return { text: audio.toString('utf8'), isFinal: true, confidence: 0.9 };
  }

  createStream(
    _languageCode: string,
    onResult: (r: TranscriptResult) => void,
  ): SttStream {
    const frames: Buffer[] = [];
    return {
      pushAudio: (frame) => frames.push(frame),
      end: () => {
        const text = Buffer.concat(frames).toString('utf8').trim();
        if (text) onResult({ text, isFinal: true, confidence: 0.9 });
      },
    };
  }

  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    // Encode the text so consumers (e.g. mock telephony) can "play" it back.
    return {
      audio: Buffer.from(opts.text, 'utf8'),
      contentType: 'audio/x-mock',
    };
  }
}
