import type {
  SpeechProvider,
  SttStream,
  SynthesizeOptions,
  SynthesizeResult,
  TranscriptResult,
} from './types';

// Google Cloud Speech-to-Text + Text-to-Speech.
//
// This adapter is intentionally dependency-light: it calls the Google Cloud
// REST endpoints with an API key (GOOGLE_CLOUD_API_KEY) so the project can run
// without the heavyweight @google-cloud/* gRPC client libraries. For production
// streaming STT you'd switch createStream() to the gRPC streaming recognizer;
// here it buffers frames and runs a batch recognize on end() — adequate for the
// MVP and easy to upgrade.
export class GoogleSpeechProvider implements SpeechProvider {
  readonly name = 'google-speech';
  private apiKey: string;

  constructor() {
    const key = process.env.GOOGLE_CLOUD_API_KEY;
    if (!key) {
      throw new Error(
        'GOOGLE_CLOUD_API_KEY is not set (required when USE_MOCK_SPEECH=false). ' +
          'For gRPC streaming + service-account auth, set GOOGLE_APPLICATION_CREDENTIALS ' +
          'and swap in the @google-cloud/speech client.',
      );
    }
    this.apiKey = key;
  }

  async transcribe(audio: Buffer, languageCode: string): Promise<TranscriptResult> {
    const res = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            // Twilio Media Streams deliver 8kHz mulaw; adjust per your bridge.
            encoding: 'MULAW',
            sampleRateHertz: 8000,
            languageCode,
            enableAutomaticPunctuation: true,
          },
          audio: { content: audio.toString('base64') },
        }),
      },
    );
    const data = (await res.json()) as any;
    const alt = data?.results?.[0]?.alternatives?.[0];
    return {
      text: alt?.transcript ?? '',
      isFinal: true,
      confidence: alt?.confidence,
    };
  }

  createStream(
    languageCode: string,
    onResult: (r: TranscriptResult) => void,
  ): SttStream {
    // Lightweight buffering recognizer. Collects frames and recognizes on end.
    const frames: Buffer[] = [];
    return {
      pushAudio: (frame: Buffer) => {
        frames.push(frame);
      },
      end: () => {
        const audio = Buffer.concat(frames);
        if (audio.length === 0) return;
        this.transcribe(audio, languageCode)
          .then((r) => onResult(r))
          .catch((err) => {
            console.error('[google-speech] transcribe failed', err);
          });
      },
    };
  }

  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: opts.text },
          voice: { languageCode: opts.languageCode, name: opts.voiceId },
          // MULAW/8kHz matches Twilio Media Streams playback.
          audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 },
        }),
      },
    );
    const data = (await res.json()) as any;
    const b64 = data?.audioContent ?? '';
    // Google returns MULAW wrapped in a WAV (RIFF) container; Twilio Media
    // Streams expect RAW mulaw/8000. Strip the header down to the `data` chunk.
    const audio = stripWavHeader(Buffer.from(b64, 'base64'));
    return {
      audio,
      contentType: 'audio/basic',
    };
  }
}

// Return the payload of a WAV's `data` chunk, or the buffer unchanged if it's
// not RIFF-wrapped (already raw).
function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let offset = 12; // past "RIFF"<size>"WAVE"
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'data') {
      return buf.subarray(dataStart, Math.min(dataStart + chunkSize, buf.length));
    }
    offset = dataStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return buf;
}
