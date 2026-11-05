import { describe, it, expect } from 'vitest';
import {
  codecForProvider,
  buildMediaMessage,
  buildClearMessage,
  PLIVO_CODEC,
  MULAW_CODEC,
} from '@/lib/voice/codec';
import { PlivoProvider } from '@/lib/adapters/telephony/plivo';

describe('codecForProvider', () => {
  it('returns the Plivo codec for plivo', () => {
    expect(codecForProvider('plivo')).toBe(PLIVO_CODEC);
    expect(PLIVO_CODEC.provider).toBe('plivo');
    expect(PLIVO_CODEC.outboundDialect).toBe('plivo');
    // Plivo shares Twilio's mulaw/8k audio format.
    expect(PLIVO_CODEC.deepgramEncoding).toBe('mulaw');
    expect(PLIVO_CODEC.frameBytes).toBe(MULAW_CODEC.frameBytes);
  });
});

describe('outbound WS dialects', () => {
  it('builds Twilio-style media/clear frames', () => {
    expect(buildMediaMessage(MULAW_CODEC, 'SID123', 'AAAA')).toEqual({
      event: 'media',
      media: { payload: 'AAAA' },
      streamSid: 'SID123',
    });
    expect(buildClearMessage(MULAW_CODEC, 'SID123')).toEqual({ event: 'clear', streamSid: 'SID123' });
    // No stream id yet → nothing to clear.
    expect(buildClearMessage(MULAW_CODEC, '')).toBeNull();
  });

  it('builds Plivo playAudio/clearAudio frames', () => {
    expect(buildMediaMessage(PLIVO_CODEC, 'ST1', 'BBBB')).toEqual({
      event: 'playAudio',
      media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: 'BBBB' },
    });
    expect(buildClearMessage(PLIVO_CODEC, 'ST1')).toEqual({ event: 'clearAudio', streamId: 'ST1' });
    // Plivo can clear even before a stream id is known.
    expect(buildClearMessage(PLIVO_CODEC, '')).toEqual({ event: 'clearAudio' });
  });
});

describe('PlivoProvider', () => {
  const p = new PlivoProvider({ authId: 'MA1234567890ABCDEFGH', authToken: 'secret-token' });

  it('advertises Twilio-like capabilities', () => {
    expect(p.name).toBe('plivo');
    expect(p.canBuyNumbers).toBe(true);
    expect(p.usesAnswerWebhook).toBe(true);
  });

  it('builds a bidirectional stream answer document pointed at /plivo', () => {
    const doc = p.buildAnswerDocument({ voiceWsUrl: 'wss://example.com', callId: 'call_1' });
    expect(doc.contentType).toBe('text/xml');
    expect(doc.body).toContain('bidirectional="true"');
    expect(doc.body).toContain('keepCallAlive="true"');
    expect(doc.body).toContain('audio/x-mulaw;rate=8000');
    expect(doc.body).toContain('wss://example.com/plivo?callId=call_1');
  });

  it('requires credentials', () => {
    expect(() => new PlivoProvider({ authId: '', authToken: '' })).toThrow();
  });
});
