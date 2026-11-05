/**
 * One phone call's conversation with Gemini Live.
 *
 * Gemini Live is a websocket you stream raw audio into and get raw audio back
 * out of. There is no request and no response — the model decides when to talk,
 * including deciding to stop mid-sentence because it heard the caller start.
 *
 * This class owns that socket and nothing else. It knows nothing about Twilio;
 * server.js does the translating. That separation is what lets you swap the
 * telephony provider without touching the model code.
 */

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { buildSystemInstruction } from '../agent/prompt.js';
import { declarations, runTool } from './tools.js';

export class LiveSession {
  /**
   * @param {object} opts
   * @param {(pcm24k: Buffer) => void} opts.onAudio      model speech, PCM16 24kHz
   * @param {() => void}               opts.onInterrupt  caller talked over the agent
   * @param {(who, text) => void}      opts.onTranscript 'caller' | 'agent'
   * @param {() => void}               opts.onHangUp     the agent decided the call is over
   * @param {object}                   opts.ctx          { callSid, from }
   */
  constructor(opts) {
    this.opts = opts;
    this.ctx = opts.ctx || {};
    this.session = null;
    this.closed = false;
    // Transcripts arrive as fragments, a few words at a time. Buffer them and
    // flush on turn boundaries so the call log holds sentences, not confetti.
    this.callerText = '';
    this.agentText = '';
  }

  async connect() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set — see GUIDE section 3.');

    // The SDK reads GOOGLE_API_KEY from the environment and prefers it over the
    // key passed here. On a machine that has one set for something else — and
    // plenty of developer machines do — your calls would quietly bill the wrong
    // project. Removing it leaves exactly one key in play: the one configured
    // in the setup screen.
    delete process.env.GOOGLE_API_KEY;

    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest';
    const tools = declarations();

    const systemInstruction = buildSystemInstruction();
    if (process.env.LOG_PROMPT === 'true') {
      console.log('\n─── system instruction ───\n' + systemInstruction + '\n──────────────────────────\n');
    }

    this.session = await ai.live.connect({
      model,
      config: {
        // Audio only. Ask for text as well and the model writes out its reply
        // before speaking it, which you pay for and the caller waits through.
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.AGENT_VOICE || 'Aoede' } },
          // Native-audio models choose the language themselves, from the
          // system instruction and from what the caller speaks — sending
          // languageCode to one does nothing at best. Half-cascade models do
          // honour it, and need it to pronounce a locale correctly.
          ...(/native-audio/i.test(model)
            ? {}
            : { languageCode: process.env.AGENT_LANGUAGE || 'en-US' }),
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // Both directions, so the call log has a transcript. These cost
        // nothing extra and are the only way to debug a call after the fact.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
        realtimeInputConfig: {
          automaticActivityDetection: {
            // How eager the model is to treat sound as the caller starting to
            // speak, and how long a pause means they have finished.
            //
            // silenceDurationMs is the single most consequential number in this
            // file. Too high and the agent feels sluggish; too low and it
            // interrupts anyone who pauses to think. 300ms suits an unhurried
            // caller. Try 150 for a snappier agent and listen to both.
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            silenceDurationMs: Number(process.env.SILENCE_MS || 300),
            prefixPaddingMs: 40,
          },
        },
      },
      callbacks: {
        onopen: () => console.log('[live] model session open'),
        onmessage: (m) => this.onMessage(m),
        onerror: (e) => console.error('[live] model error:', e?.message || e),
        onclose: (e) => {
          const reason = e?.reason || '';
          // Always log the reason, even for an expected close. When a call
          // produces silence this line is the only thing that says why, and
          // "credits depleted" looks identical to "broken kit" without it.
          if (reason) console.warn('[live] model session closed:', reason);
          if (this.closed) return;

          if (/credit|billing|quota|exhaust|deplete|payment/i.test(reason)) {
            console.warn(
              '[live] ⚠ The agent could not speak because the Google project cannot run live calls.\n' +
              '       The Live API is billed — add credits at https://ai.studio/projects, then try again.',
            );
          }

          // Nothing here reconnects. A caller left on a silent line will hang
          // up confused; hanging up for them at least ends it honestly.
          this.opts.onHangUp?.();
        },
      },
    });

    // The caller has not said anything yet, so nothing would prompt a first
    // turn. Nudge the model to speak so the line is not silent when answered.
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: 'The call has connected. Greet the caller now.' }] }],
      turnComplete: true,
    });
  }

  /** Caller audio in, as PCM16 16kHz. */
  sendAudio(pcm16k) {
    if (!this.session || this.closed) return;
    try {
      this.session.sendRealtimeInput({
        audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch (err) {
      console.error('[live] send failed:', err.message);
    }
  }

  async onMessage(m) {
    // Gemini caps how long one session may run and warns before cutting it.
    if (m.goAway) {
      console.warn('[live] model is ending the session:', m.goAway.timeLeft || '');
      this.opts.onHangUp?.();
      return;
    }

    if (m.toolCall?.functionCalls?.length) {
      for (const fc of m.toolCall.functionCalls) await this.handleToolCall(fc);
      return;
    }

    const sc = m.serverContent;
    if (!sc) return;

    // The model noticed the caller talking over it and abandoned its turn.
    // Whatever it already sent is sitting in the phone network's buffer and
    // will keep playing unless we explicitly flush it.
    if (sc.interrupted) {
      this.flush('agent');
      this.opts.onInterrupt?.();
      return;
    }

    for (const part of sc.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (data) this.opts.onAudio?.(Buffer.from(data, 'base64'));
    }

    // Mind the names. You ASK for transcripts with `inputAudioTranscription`
    // and `outputAudioTranscription` in the config, but they come BACK as
    // `inputTranscription` and `outputTranscription`. Reading the config names
    // here silently produces an empty call log — everything works, every
    // transcript is blank, and there is no error to chase. The longer names
    // are kept as a fallback in case a future SDK aligns them.
    const heard = sc.inputTranscription ?? sc.inputAudioTranscription;
    const said = sc.outputTranscription ?? sc.outputAudioTranscription;
    if (heard?.text) this.callerText += heard.text;
    if (said?.text) this.agentText += said.text;

    if (sc.turnComplete) {
      this.flush('caller');
      this.flush('agent');
    }
  }

  async handleToolCall(fc) {
    console.log('[tool]', fc.name, JSON.stringify(fc.args || {}));
    const result = await runTool(fc.name, fc.args || {}, this.ctx);

    // Answer the model even when hanging up. A tool call left unanswered keeps
    // the session waiting, and the goodbye never finishes playing.
    try {
      this.session?.sendToolResponse({
        functionResponses: [{ id: fc.id, name: fc.name, response: result }],
      });
    } catch (err) {
      console.error('[live] tool response failed:', err.message);
    }

    if (result.ending) this.opts.onHangUp?.();
  }

  flush(who) {
    const text = who === 'caller' ? this.callerText : this.agentText;
    if (!text.trim()) return;
    this.opts.onTranscript?.(who, text.trim());
    if (who === 'caller') this.callerText = '';
    else this.agentText = '';
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch {
      // Already gone. Nothing to do, and nothing worth logging.
    }
  }
}
