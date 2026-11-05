// Speech adapter — Speech-to-Text (STT) and Text-to-Speech (TTS).
// The realtime pipeline feeds audio frames to STT and plays TTS audio back.

export type TranscriptResult = {
  text: string;
  isFinal: boolean;
  confidence?: number;
};

export type SynthesizeOptions = {
  text: string;
  languageCode: string; // BCP-47
  voiceId: string;
};

export type SynthesizeResult = {
  // Raw audio bytes (mock returns a tiny placeholder buffer).
  audio: Buffer;
  // Audio container/encoding, e.g. "audio/mpeg" or "audio/l16;rate=8000".
  contentType: string;
};

export interface SpeechProvider {
  readonly name: string;

  // Batch transcription of a complete audio buffer (used in non-streaming
  // paths and tests). The realtime path uses createStream() below.
  transcribe(audio: Buffer, languageCode: string): Promise<TranscriptResult>;

  // Open a streaming recognizer. Push audio frames; receive partial + final
  // transcripts via the onResult callback.
  createStream(
    languageCode: string,
    onResult: (r: TranscriptResult) => void,
  ): SttStream;

  synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>;
}

export interface SttStream {
  pushAudio(frame: Buffer): void;
  end(): void;
}
