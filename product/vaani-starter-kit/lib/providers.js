/**
 * Everything that differs between Twilio and Exotel, in one place.
 *
 * The rest of the kit does not know which one is in use. Add a third provider
 * by adding an entry here — that is the whole point of this file existing.
 *
 * The four differences that actually matter:
 *
 *   AUDIO     Twilio speaks 8kHz µ-law, one byte a sample. Exotel speaks raw
 *             16-bit PCM at 8kHz, two bytes a sample. Nothing else changes.
 *
 *   FRAMING   Twilio wants 20ms frames (160 bytes). Exotel wants chunks that
 *             are a multiple of 320 bytes and at least 3.2KB, so we send 200ms
 *             at a time. Send Exotel a 160-byte frame and it drops it silently.
 *
 *   NAMING    Twilio calls the stream id `streamSid`; Exotel calls it
 *             `stream_sid`. Same idea, and a reliable source of confusion.
 *
 *   ANSWERING Twilio asks your server what to do when a call arrives, by
 *             POSTing to /voice, and you answer with TwiML. Exotel does not ask
 *             anything — you attach a Voicebot applet to the number in Exotel's
 *             dashboard, pointing straight at the websocket. So there is no
 *             webhook to configure for Exotel, and no TwiML.
 */

import {
  mulaw8kToPcm16k,
  pcm24kToMulaw8k,
  mulawEnergy,
  pcm8kToPcm16k,
  pcm24kToPcm8k,
  pcm16Energy,
} from './codec.js';

export const PROVIDERS = {
  twilio: {
    key: 'twilio',
    label: 'Twilio',
    // Where its websocket connects.
    wsPath: '/media',
    // Twilio fetches an answer document when a call arrives; Exotel does not.
    usesAnswerWebhook: true,
    frameBytes: 160, // 20ms of µ-law/8k
    silenceByte: 0xff, // µ-law silence is 0xff, not zero
    streamSidField: 'streamSid',
    decodeToPcm16k: mulaw8kToPcm16k,
    encodeFromPcm24k: pcm24kToMulaw8k,
    energy: mulawEnergy,

    /** What Twilio must be told when a call comes in. */
    answerDocument(publicUrl) {
      const wsUrl = publicUrl.replace(/^http/, 'ws') + this.wsPath;
      // <Connect><Stream> is two-way. <Start><Stream> only copies audio TO you,
      // which produces an agent that can hear but cannot be heard — far and
      // away the most common first-attempt mistake.
      //
      // The <Parameter> is how the caller's number reaches the websocket;
      // without it the agent cannot send a WhatsApp confirmation.
      return {
        contentType: 'text/xml',
        body:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Response><Connect><Stream url="' + wsUrl + '">' +
          '<Parameter name="from" value="{{From}}" />' +
          '</Stream></Connect></Response>',
      };
    },

    /** Read the start message Twilio sends when the stream opens. */
    readStart(msg) {
      return {
        streamSid: msg.start?.streamSid || msg.streamSid || '',
        callSid: msg.start?.callSid || msg.streamSid || '',
        from: msg.start?.customParameters?.from || null,
        to: msg.start?.customParameters?.to || null,
      };
    },

    mediaMessage(streamSid, payloadBase64) {
      return { event: 'media', streamSid, media: { payload: payloadBase64 } };
    },

    /** Throw away audio we already sent but which has not played yet. */
    clearMessage(streamSid) {
      return { event: 'clear', streamSid };
    },
  },

  exotel: {
    key: 'exotel',
    label: 'Exotel',
    wsPath: '/exotel',
    usesAnswerWebhook: false,
    // 3200 bytes = 200ms of PCM16/8k, comfortably inside Exotel's 3.2KB–100KB
    // window and a clean multiple of 320.
    frameBytes: 3200,
    silenceByte: 0x00,
    streamSidField: 'stream_sid',
    decodeToPcm16k: pcm8kToPcm16k,
    encodeFromPcm24k: pcm24kToPcm8k,
    energy: pcm16Energy,

    answerDocument() {
      // Exotel never asks. Routing is a Voicebot applet in their dashboard.
      return null;
    },

    readStart(msg) {
      const s = msg.start || {};
      return {
        streamSid: s.stream_sid || msg.stream_sid || '',
        callSid: s.call_sid || s.stream_sid || msg.stream_sid || '',
        // Exotel puts the caller's number on the start message itself, so
        // unlike Twilio there is nothing extra to configure to get it.
        from: s.from || s.From || null,
        to: s.to || s.To || null,
      };
    },

    mediaMessage(streamSid, payloadBase64) {
      return { event: 'media', stream_sid: streamSid, media: { payload: payloadBase64 } };
    },

    clearMessage(streamSid) {
      return { event: 'clear', stream_sid: streamSid };
    },
  },
};

export function providerFor(key) {
  return PROVIDERS[key] || PROVIDERS.twilio;
}

/**
 * Split synthesised audio into frames this provider will accept.
 *
 * Exotel rejects anything not a multiple of 320 bytes, so a short final chunk
 * is padded with silence rather than dropped — dropping it clips the last
 * syllable off every sentence.
 */
export function frameAudio(provider, audio) {
  const frames = [];
  for (let i = 0; i < audio.length; i += provider.frameBytes) {
    let chunk = audio.subarray(i, i + provider.frameBytes);
    if (provider.key === 'exotel' && chunk.length % 320 !== 0) {
      const padded = Buffer.alloc(Math.ceil(chunk.length / 320) * 320, provider.silenceByte);
      chunk.copy(padded);
      chunk = padded;
    }
    frames.push(chunk);
  }
  return frames;
}
