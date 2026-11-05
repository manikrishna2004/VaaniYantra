import WebSocket from 'ws';

// Deepgram streaming Speech-to-Text for telephony. Transcribes mulaw/8kHz audio
// in real time and fires onUtterance when Deepgram detects end-of-speech — this
// removes the batch round-trip (the big latency win over Google recognize).

export type DeepgramLive = {
  send(frame: Buffer): void;
  close(): void;
};

// Map our BCP-47 agent languages to Deepgram language codes.
const LANG_MAP: Record<string, string> = {
  'en-IN': 'en-IN',
  'hi-IN': 'hi',
  'ta-IN': 'ta',
  'te-IN': 'te',
  'ml-IN': 'ml',
};

export function openDeepgram(opts: {
  apiKey: string;
  languageCode: string;
  onUtterance: (text: string) => void;
  // Wire encoding of the audio frames fed to send(): 'mulaw' (Twilio) or
  // 'linear16' (Exotel PCM16). Defaults to mulaw.
  encoding?: 'mulaw' | 'linear16';
}): DeepgramLive {
  const lang = LANG_MAP[opts.languageCode] || 'en-IN';
  // nova-2-phonecall is tuned for 8kHz telephony English; other languages use
  // the general nova-2 model.
  const model = lang.startsWith('en') ? 'nova-2-phonecall' : 'nova-2';
  const params = new URLSearchParams({
    encoding: opts.encoding || 'mulaw',
    sample_rate: '8000',
    channels: '1',
    model,
    language: lang,
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300', // ms of silence before finalizing a segment
    utterance_end_ms: '1000',
  });

  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
    headers: { Authorization: `Token ${opts.apiKey}` },
  });

  let buffer = ''; // accumulates finalized segments until end-of-speech
  let keepAlive: NodeJS.Timeout | null = null;

  const flush = () => {
    const u = buffer.trim();
    buffer = '';
    if (u) opts.onUtterance(u);
  };

  ws.on('open', () => {
    console.log('[deepgram] connected:', model, lang);
    // Keep the socket alive during long agent turns when no audio is flowing.
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 5000);
  });

  ws.on('message', (raw) => {
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === 'Results') {
      const alt = m.channel?.alternatives?.[0];
      const txt = (alt?.transcript || '').trim();
      if (txt && m.is_final) buffer = buffer ? `${buffer} ${txt}` : txt;
      if (m.speech_final) flush();
    } else if (m.type === 'UtteranceEnd') {
      flush();
    }
  });

  ws.on('error', (e) => console.error('[deepgram] error:', e.message));
  ws.on('close', () => {
    if (keepAlive) clearInterval(keepAlive);
  });

  return {
    send: (frame: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    },
    close: () => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
      if (keepAlive) clearInterval(keepAlive);
      ws.close();
    },
  };
}
