import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import type { WebSocket } from 'ws';
import { prisma } from '@/lib/db';
import { recordTurn, summarizeCall } from '@/lib/voice/conversation';
import { retrieveForAgent, formatKnowledgeBlock } from '@/lib/rag/retrieve';
import { languageForCaller } from '@/lib/constants';
import { applyVariables, matchesTransferTrigger } from '@/lib/agent-behavior';
import { composeSystemInstruction } from '@/lib/voice/prompt';
import { TYPING_MULAW_8K, TYPING_FRAME_BYTES } from '@/lib/voice/typing-sound';
import { dispatchCallEvent } from '@/lib/webhooks';
import { finalizeCallRecord } from '@/lib/voice/finalize';
import { pushCallToCrm } from '@/lib/crm';
import { getGeminiApiKey, getLiveConfig, getBaseSystemPrompt, getCallGuidance } from '@/lib/platform';
import { isDemoNumber, buildPlatformDemoPrompt } from '@/lib/demo-agent';
import { costOptimized } from '@/lib/flags';
import { emptyCallState, updateFromTool, restateAfterCompression, type CallState } from '@/lib/voice/call-state';
import { getOrgCredentials, type OrgCredentials } from '@/lib/integrations';
import { agentGeminiKey } from '@/lib/agent-gemini';
import { synthesizeTelephony } from '@/lib/voice/tts';
import {
  detectRedFlag,
  emergencySpokenReply,
  emergencyModelNotice,
  raiseVoiceEmergency,
  type RedFlag,
} from '@/lib/voice/emergency';
import { providerForNumberId } from '@/lib/telephony-accounts';
import { getCallConnectorTools, type ConnectorTool } from '@/lib/connectors/tools';
import { readBookingConfig } from '@/lib/connectors/booking';
import { readOutcomeConfig } from '@/lib/connectors/outcomes';
import { toE164 } from '@/lib/phone';
import { codecForProvider, buildMediaMessage, buildClearMessage, frameEnergy, type TelephonyCodec } from '@/lib/voice/codec';
import { resolveInboundCall } from '@/lib/voice/inbound';
import { emptyUsage, accumulateUsage, estimateCostInr, type LiveUsage } from '@/lib/voice/usage';
import type { Agent } from '@prisma/client';

// Gemini Live realtime pipeline (Ultravox-class architecture).
//
// One bidirectional WebSocket to Gemini Live carries the whole conversation:
// caller audio in -> native speech model -> audio out, with built-in VAD and
// barge-in. This replaces the STT -> LLM -> TTS chain for the lowest latency.
//
// Audio bridging with Twilio Media Streams:
//   Twilio in : mulaw 8kHz  -> (decode + upsample) -> PCM16 16kHz -> Gemini
//   Gemini out: PCM16 24kHz -> (downsample + encode) -> mulaw 8kHz -> Twilio

// The context window opted-out agents keep — what the pipeline shipped with,
// before the defaults tightened for cost. Frozen here rather than read from
// config so that retuning the platform default cannot silently change how the
// demo agent behaves.
const LEGACY_COMPRESSION_TRIGGER = 12000;
const LEGACY_COMPRESSION_TARGET = 6000;

export class LiveCallSession {
  private streamSid = '';
  private startedAt = Date.now();
  private agent: Agent | null = null;
  private session: Session | null = null;
  private ai: GoogleGenAI;
  private closed = false;
  private providerSid: string | null = null;
  // #1: the dialled number's id, so transfers/hang-ups use its Twilio account.
  private phoneNumberId: string | null = null;
  private transferring = false;
  // #3: whether this call registered the end_call function tool.
  private endCallTool = false;
  private endingCall = false; // end_call in progress (goodbye draining)
  // Playback clock: wall-clock time until which already-sent outbound audio is
  // still playing to the caller (Gemini streams faster than realtime, so the
  // provider buffers seconds of speech). Used to not cut off the goodbye.
  private audioSentUntil = 0;
  // Phase A: live connector tools (e.g. appointment booking), by tool name.
  private connectorTools = new Map<string, ConnectorTool>();
  private connectorCtx: { orgId: string; customerNumber: string | null } | null = null;

  // Typing-sound ("thinking" ambience) state — gated, default-off (admin).
  private typingEnabled = false;
  private typingPlaying = false;
  private typingPos = 0; // byte offset into the looped mulaw buffer
  private typingArmTimer: ReturnType<typeof setTimeout> | null = null; // debounce after caller stops
  private typingFrameTimer: ReturnType<typeof setInterval> | null = null; // 20ms frame sender
  private typingStopTimer: ReturnType<typeof setTimeout> | null = null; // safety cap
  private agentAudioThisTurn = false; // first agent audio chunk of the current turn?
  private agentTurnStartedAt = 0; // ms when the agent's current turn audio began
  private lastCallerInputAt = 0; // ms timestamp of last caller transcription (for gap diag)

  // Incrementally accumulated transcripts for the current turn.
  private callerText = '';
  private agentText = '';

  // Emergency tripwire state. Fires at most once per call: the caller has been
  // told to hang up and dial, and repeating that over every subsequent sentence
  // would talk over someone who is trying to act on it.
  private emergencyFired = false;
  // Call context the tripwire needs. Set in connect(); the tripwire degrades to
  // "speak, but no clinic alert" rather than failing if any of it is missing.
  private orgId: string | null = null;
  private callerNumber: string | null = null;
  private language = 'en-IN';
  private creds: OrgCredentials = {};

  // Wire audio codec for this call's provider (mulaw for Twilio, PCM16 for
  // Exotel). Set from the constructor's provider arg.
  private codec: TelephonyCodec;

  // Token spend for this call, summed from the per-turn usageMetadata reports.
  // The model that actually ran is recorded alongside it because the admin
  // dashboard overrides the env default, so .env does not tell you what billed.
  private usage: LiveUsage = emptyUsage();
  private liveModel = '';

  // Whether this agent takes the cost-optimised path (see flags.costOptimized).
  // Resolved once the agent is loaded; false until then, so nothing new can run
  // before we know which agent we are serving.
  private optimize = false;
  // Tools whose second identical invocation is never wanted: they write, or
  // they send the caller a message. Read-only tools are deliberately absent —
  // check_availability asked twice can legitimately return a different answer,
  // and serving the first reply again would hand the model stale slots.
  private static readonly WRITE_ONCE = new Set([
    'record_outcome',
    'book_appointment',
    'reschedule_appointment',
    'cancel_appointment',
  ]);
  // Of those, the ones that are once per CALL rather than once per argument
  // set. Keying record_outcome on its arguments was not enough: the model
  // re-called it with the town drifted from "Kokapet, Hyderabad" to
  // "Hyderabad", which is a different key and therefore a second enquiry and a
  // second WhatsApp for the same caller. It records the outcome OF the call, so
  // the call is the right unit. A booking tool is not here — rescheduling twice
  // in one call is a thing a caller may legitimately do.
  private static readonly ONCE_PER_CALL = new Set(['record_outcome']);
  // Per-call, keyed by tool name (+ arguments, for everything but the above).
  // Holds the promise rather than the result so a duplicate arriving while the
  // first is still running waits for it instead of starting a second.
  private toolOnce = new Map<string, Promise<Record<string, unknown>>>();

  // What the backend knows about the call, so a tight context window does not
  // cost the agent its memory. See src/lib/voice/call-state.ts.
  private callState: CallState = emptyCallState();
  // Previous turn's prompt size. A sharp drop is the sliding window firing —
  // the only signal we get that the model has just forgotten something.
  private lastPromptTokens = 0;

  // Barge-in: true while a reply the caller talked over is still arriving, so
  // its remaining chunks are dropped instead of resuming over them.
  private outputSuppressed = false;

  // Carrier-leg watchdogs. Nothing else notices a dead call: a half-open TCP
  // socket (routine on mobile NAT) never fires 'close', so finalize never runs,
  // and the stale-call sweeper only tidies the database row — it has no handle
  // on this object and cannot close the Gemini session. The session then stays
  // open, and billing, on a call that ended long ago.
  private mediaWatchdog: ReturnType<typeof setTimeout> | null = null;
  private maxCallTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false; // hardStop re-entry guard

  // Inbound silence gate — see shouldForward. Resolved once the agent is known;
  // vadGate stays false for opted-out agents and whenever the flag is off.
  private vadGate = false;
  private vadFloor = 0.015; // matches the cascade pipeline's ENERGY_THRESHOLD
  private vadHangoverMs = 600;
  private preRollFrames = 5; // ~100ms at 20ms frames
  private preRoll: Buffer[] = [];
  private lastVoiceAt = 0;

  constructor(
    private ws: WebSocket,
    private callId: string | null,
    private provider: 'twilio' | 'exotel' | 'plivo' | 'mock' = 'twilio',
  ) {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    this.codec = codecForProvider(provider);
  }

  async run() {
    // Both handlers are fire-and-forget, so anything that rejects inside them
    // surfaces as an unhandled rejection — which, in a process shared by every
    // concurrent call, used to mean everyone's call ended. Catch here as well as
    // at the process level, so the failure is attributable to a call.
    this.ws.on('message', (raw) => {
      void this.onProviderMessage(raw.toString()).catch((err) =>
        console.error('[live] message handler failed, call:', this.callId, err),
      );
    });
    this.ws.on('close', () => {
      void this.finalize().catch((err) =>
        console.error('[live] finalize failed, call:', this.callId, err),
      );
    });
  }

  private ms() {
    return Date.now() - this.startedAt;
  }

  /**
   * Whether this inbound frame is worth sending to Gemini.
   *
   * Carriers send a frame every 20ms for the entire call — silence included, and
   * the caller is silent for most of it, because for much of a call the agent is
   * the one talking. All of it used to go to Gemini, which meant paying to
   * transcribe the caller saying nothing and, worse, carrying that silence in
   * the session window where it is re-billed on every subsequent turn.
   *
   * The gate keeps the shape of an utterance intact rather than clipping it:
   *   • pre-roll — a short ring buffer flushed on speech onset, so the first
   *     consonant is not lost (a gate that eats "…es" out of "yes" is worse than
   *     no gate);
   *   • hangover — frames keep flowing for a moment after the voice stops. This
   *     deliberately exceeds silenceDurationMs so Gemini's own VAD still sees
   *     the trailing silence it needs to decide the turn ended. Cut it shorter
   *     than that and turns stop committing at all.
   *
   * Off unless GEMINI_LIVE_VAD_GATE=on, and never applied to an opted-out agent.
   */
  private shouldForward(wire: Buffer): boolean {
    if (!this.vadGate) return true;
    const now = Date.now();
    if (frameEnergy(this.codec, wire) > this.vadFloor) {
      // Speech. Flush whatever ran up to it, then stream normally.
      if (this.preRoll.length) {
        for (const f of this.preRoll) this.forwardWire(f);
        this.preRoll.length = 0;
      }
      this.lastVoiceAt = now;
      return true;
    }
    if (this.lastVoiceAt && now - this.lastVoiceAt < this.vadHangoverMs) return true;
    // Silence. Hold the most recent frames in case speech starts next.
    this.preRoll.push(wire);
    if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
    return false;
  }

  /** Send one already-decoded-from-base64 wire frame to Gemini. */
  private forwardWire(wire: Buffer) {
    if (!this.session) return;
    const pcm16 = this.codec.decodeToPcm16k(wire);
    this.session.sendRealtimeInput({
      audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  private static envNum(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private static envMs(name: string, fallback: number): number {
    return LiveCallSession.envNum(name, fallback);
  }

  /**
   * Restart the media-gap timer. Carriers send a frame every 20ms for the whole
   * call — silence included — so a gap this long means the leg is gone, whether
   * or not the socket admitted it.
   */
  private touchMediaWatchdog() {
    if (this.closed) return;
    if (this.mediaWatchdog) clearTimeout(this.mediaWatchdog);
    const idleMs = LiveCallSession.envMs('LIVE_MEDIA_IDLE_MS', 30_000);
    this.mediaWatchdog = setTimeout(() => {
      console.warn('[live] no carrier media for', idleMs, 'ms — ending call', this.callId);
      this.hardStop();
    }, idleMs);
  }

  /** Tear down a call the caller is no longer on. finalize() does the rest. */
  private hardStop() {
    // Re-entry guard, and not a theoretical one: closing the session fires the
    // `onclose` callback, which calls hardStop for exactly the case where the
    // model drops mid-call. Without this it would recurse straight back in.
    if (this.stopping || this.closed) return;
    this.stopping = true;
    this.clearWatchdogs();
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    // The socket may already be half-open, in which case close() never fires the
    // 'close' handler — so finalize is called directly rather than waited on.
    void this.finalize().catch((err) => console.error('[live] finalize after hard stop failed', err));
  }

  private clearWatchdogs() {
    if (this.mediaWatchdog) { clearTimeout(this.mediaWatchdog); this.mediaWatchdog = null; }
    if (this.maxCallTimer) { clearTimeout(this.maxCallTimer); this.maxCallTimer = null; }
  }

  private async onProviderMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.event) {
      case 'connected': // Exotel handshake — nothing to do until `start`.
        break;
      case 'start': {
        // streamSid casing differs by provider (Twilio streamSid / Exotel
        // stream_sid / Plivo streamId).
        this.streamSid =
          msg.start?.streamSid ?? msg.start?.stream_sid ?? msg.start?.streamId ??
          msg.streamSid ?? msg.stream_sid ?? msg.streamId ?? '';
        this.startedAt = Date.now();
        this.touchMediaWatchdog();
        // Absolute cap, so a call that somehow keeps media flowing without ever
        // ending cannot bill forever.
        const maxMs = LiveCallSession.envMs('LIVE_MAX_CALL_MS', 30 * 60_000);
        this.maxCallTimer = setTimeout(() => {
          console.warn('[live] call exceeded', maxMs, 'ms — ending', this.callId);
          this.hardStop();
        }, maxMs);
        await this.resolveCallId(msg);
        console.log('[live] stream started, provider:', this.provider, 'callId:', this.callId);
        if (this.callId) {
          try {
            await this.openLive();
          } catch (err) {
            // Where a provider outage lands: depleted quota, a revoked key, a
            // 429. Nothing below this point can run, so close the socket rather
            // than leaving the caller on an open line hearing nothing.
            // finalize() then records `no_conversation`, which is what the
            // call-failure alert watches for.
            console.error('[live] could not open model session, call:', this.callId, err);
            this.ws.close();
          }
        } else this.ws.close();
        break;
      }
      case 'media': {
        this.touchMediaWatchdog();
        const payload = msg.media?.payload;
        if (payload && this.session) {
          const wire = Buffer.from(payload, 'base64');
          if (!this.shouldForward(wire)) break;
          // Wire audio -> PCM16 16kHz for Gemini. Use the `audio` field (the
          // legacy `media` field is rejected with a 1007 close by newer
          // half-cascade models like gemini-3.1-flash-live-preview).
          const pcm16 = this.codec.decodeToPcm16k(wire);
          this.session.sendRealtimeInput({
            audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
          });
        }
        break;
      }
      case 'stop':
        this.ws.close();
        break;
    }
  }

  // Resolve the callId from the start event. Twilio carries it as a custom
  // Stream parameter; Exotel supplies it in custom_parameters for outbound (we
  // set it) or, for inbound, we look up the dialled number and create the Call.
  private async resolveCallId(msg: any) {
    const paramCallId =
      msg.start?.customParameters?.callId ?? msg.start?.custom_parameters?.callId;
    if (paramCallId) {
      this.callId = paramCallId;
      return;
    }
    if (this.callId) return; // already known (Twilio path / query fallback)
    if (this.provider === 'exotel') {
      const s = msg.start ?? {};
      const res = await resolveInboundCall({
        from: s.from ?? 'unknown',
        to: s.to ?? 'unknown',
        callSid: s.call_sid,
      });
      if (res.terminal) {
        console.log('[live] exotel inbound terminal:', res.terminal);
        this.callId = null;
        return;
      }
      this.callId = res.callId;
    }
  }

  /**
   * True when the call ended while we were still setting up — and, if a session
   * did get established, closes it.
   *
   * openLive awaits a dozen round trips: the call row, org credentials, the
   * platform key, the tunables, the knowledge lookup, the connector tools, the
   * connect itself. A caller who hangs up during any of them fires the socket's
   * 'close' handler, which runs finalize() — and finalize closes `this.session`,
   * which at that point is still null. The connect then completes onto a dead
   * call, greets nobody, and stays open and billing until Google's own idle
   * timeout. That is one leaked session for every abandoned call, and it is
   * invisible: no error, no transcript, and finalize has already run so nothing
   * will ever record it.
   */
  private abandonedDuringSetup(): boolean {
    if (!this.closed) return false;
    console.log('[live] call ended during setup — closing the model session for', this.callId);
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = null;
    return true;
  }

  private async openLive() {
    const call = await prisma.call.findUnique({
      where: { id: this.callId! },
      include: {
        agent: { include: { workspace: { select: { orgId: true } } } },
      },
    });
    this.agent = (call?.agent as Agent) ?? null;
    this.providerSid = call?.providerSid ?? null;
    this.phoneNumberId = call?.phoneNumberId ?? null;
    if (!this.agent) {
      console.error('[live] no agent for call', this.callId);
      return;
    }
    // Which path this call takes. Only an agent explicitly named in
    // LIVE_COST_OPT_OUT_AGENT_IDS keeps the original behaviour; carrying its own
    // Gemini key no longer exempts one — see flags.costOptimized.
    this.optimize = costOptimized(this.agent);
    // Silence gating ships off: it is the one change here that touches live
    // audio, so it is enabled per-environment once a benchmark has confirmed
    // barge-in and the multilingual scenarios still behave.
    this.vadGate = this.optimize && process.env.GEMINI_LIVE_VAD_GATE === 'on';
    this.vadFloor = LiveCallSession.envNum('GEMINI_LIVE_VAD_FLOOR', 0.015);
    this.vadHangoverMs = LiveCallSession.envNum('GEMINI_LIVE_VAD_HANGOVER_MS', 600);
    if (this.vadGate) {
      console.log('[live] inbound silence gate on — floor', this.vadFloor, 'hangover', this.vadHangoverMs, 'ms');
    }
    // Cheapest place to notice: everything below is round trips we can skip.
    if (this.abandonedDuringSetup()) return;

    // Resolve the effective Gemini key: this agent's own key (demo accounts) >
    // org integration key > platform key (admin dashboard) > env. Lets the
    // founder rotate the key without a deploy.
    const creds = await getOrgCredentials((call?.agent as any)?.workspace?.orgId).catch(
      (): import('@/lib/integrations').OrgCredentials => ({}),
    );
    // An agent carrying its own key (demo accounts) bills that key and never
    // touches the org/platform one.
    const geminiKey =
      agentGeminiKey(this.agent) || creds.gemini || (await getGeminiApiKey().catch(() => undefined));
    if (geminiKey) this.ai = new GoogleGenAI({ apiKey: geminiKey });

    // Resolve the call language: "auto" picks from the caller's location.
    const language =
      this.agent.languageMode === 'auto'
        ? languageForCaller(call?.fromNumber, this.agent.language)
        : this.agent.language;

    // Kept on the instance for the emergency tripwire, which has to synthesize
    // its own speech without going back to the database mid-call.
    this.creds = creds;
    this.language = language;
    this.orgId = ((call?.agent as any)?.workspace?.orgId as string | undefined) ?? null;
    this.callerNumber =
      (call?.direction === 'OUTBOUND' ? call?.toNumber : call?.fromNumber) ?? null;

    if (language !== call?.language) {
      await prisma.call.update({ where: { id: this.callId! }, data: { language } }).catch(() => {});
    }

    // #10: model/voice/silence are tunable from the admin dashboard (DB > env).
    const liveCfg = await getLiveConfig();
    // Use the admin-configured model for every language. Measured: the
    // half-cascade gemini-3.1-flash-live-preview reaches first audio in ~0.6s
    // (vs ~1.9s for native-audio) AND honours languageCode for a native accent —
    // so it's both faster and more accurate; no per-language routing needed.
    const model = liveCfg.model;
    this.liveModel = model;
    console.log('[live] language:', language, '-> model:', model);
    this.typingEnabled = liveCfg.typingSound;
    // #3: per-agent Gemini Live voice (falls back to the admin default / Aoede).
    const voice = (this.agent as any).geminiVoice || liveCfg.voice;

    // #5: the shared demo line (dialled the demo number) is a salesperson for
    // VaaniYantra itself — swap in a platform-knowledge persona built from live
    // plan/language data and skip the workspace knowledge base entirely.
    const isDemo = isDemoNumber(call?.toNumber);

    // Knowledge. On the cost-optimised path this is a tool the model calls with
    // the caller's actual question (src/lib/connectors/knowledge.ts) — the block
    // below is the original behaviour, kept for opted-out agents.
    //
    // Why it moved: the system instruction sits outside the compression window,
    // so these ~1,000 tokens were re-billed on every turn of the call, retrieved
    // once against `agent.description` — the agent's own name — because at
    // connect time the caller has not asked anything yet.
    let knowledge = '';
    if (!isDemo && !this.optimize) {
      try {
        const chunks = await retrieveForAgent(this.agent.id, this.agent.description || this.agent.name, 6);
        knowledge = formatKnowledgeBlock(chunks);
      } catch {
        /* ignore */
      }
    }
    const greeting = applyVariables(
      this.agent.greeting?.trim() || 'Hello! Thanks for calling. How can I help you today?',
      this.agent.variables,
    );
    // #3: auto end-call — when the agent decides the call's purpose is done, it
    // calls the end_call function and we hang up. Owner-written instructions
    // take priority; otherwise a sensible default so every agent hangs up once
    // the caller's requirements are fulfilled (instead of waiting forever).
    const endInstr =
      (this.agent as any).endCallInstructions?.trim() ||
      "the caller's request is complete (their booking is confirmed, their details are recorded, or their questions are answered) and they confirm they need nothing else";
    this.endCallTool = true;

    // Phase A: resolve live connector tools (booking, …) for this call. Skipped
    // for the shared demo line. The customer's number is the caller (inbound) or
    // the dialled number (outbound).
    const orgId = (call?.agent as any)?.workspace?.orgId as string | undefined;
    if (!isDemo && orgId) {
      // Normalize to E.164 up front (Exotel sends local "0934…" forms) so
      // appointment records and confirmations always carry a sendable number.
      const rawCustomer = call?.direction === 'OUTBOUND' ? call?.toNumber ?? null : call?.fromNumber ?? null;
      const customerNumber = toE164(rawCustomer) ?? rawCustomer;
      this.connectorCtx = { orgId, customerNumber };
      try {
        const tools = await getCallConnectorTools({ orgId, callId: this.callId!, customerNumber, agent: this.agent });
        for (const t of tools) this.connectorTools.set(t.declaration.name, t);
      } catch (err) {
        console.error('[live] connector tools resolve failed', err);
      }
    }

    // #10: admin-editable base system prompt + spoken-call guidance.
    const basePrompt = await getBaseSystemPrompt();
    const callGuidance = (await getCallGuidance(this.optimize)).trim();

    const corePrompt = isDemo
      ? await buildPlatformDemoPrompt()
      : applyVariables(this.agent.systemPrompt, this.agent.variables);

    // Phase A: when booking tools are active, tell the agent how to use them so
    // it offers only real, calendar-backed times.
    const bookingCfg = readBookingConfig(this.agent);
    // Composed once at connect time, so a call running past midnight keeps the
    // date it started with; that is a minute of drift on a call, not a day.
    const nowInTz = new Intl.DateTimeFormat('en-GB', {
      timeZone: bookingCfg.timezone,
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
    const todayIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: bookingCfg.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // #4: assembled by the shared composer so the admin preview matches exactly.
    const systemText = composeSystemInstruction({
      basePrompt,
      corePrompt,
      knowledge,
      languageMode: this.agent.languageMode,
      language,
      fallbackMessage: this.agent.fallbackMessage,
      endCallInstructions: endInstr,
      callGuidance,
      greeting,
      recordingDisclosure: !isDemo && this.agent.recordingDisclosure === true,
      // The demo bot has no owner-configured outcome, so it has nothing to collect.
      captures: isDemo ? undefined : readOutcomeConfig(this.agent).captures,
      agentType: isDemo ? null : this.agent.agentType,
      industryLabel: isDemo ? null : (this.agent as any).industryLabel,
      booking: this.connectorTools.has('book_appointment')
        ? { nowInTz, todayIso, timezone: bookingCfg.timezone, concise: this.optimize }
        : null,
    });


    // Last chance before we spend a session at all.
    if (this.abandonedDuringSetup()) return;

    console.log('[live] connecting:', model, 'voice:', voice);
    this.session = await this.ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        // #10: sampling temperature is admin-tunable (DB > env > 0.8).
        temperature: liveCfg.temperature,
        // Voice + locale. Native-audio models pick the language themselves and
        // ignore languageCode, so we only send it for half-cascade models (where
        // it drives a locale-correct, native-accent rendering of Indian languages).
        //
        // A 'multi' agent sends no languageCode on either model. On half-cascade
        // it PINS the output locale, so a caller answering in Telugu is replied
        // to in Telugu words rendered through en-IN — which is the whole reason
        // the mode exists, defeated one line before the session opens. Without
        // it the model follows the system instruction and the caller.
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          ...(/native-audio/i.test(model) || this.agent.languageMode === 'multi'
            ? {}
            : { languageCode: language }),
        },
        systemInstruction: { parts: [{ text: systemText }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(() => {
          const functionDeclarations: any[] = [];
          if (this.endCallTool) {
            functionDeclarations.push({
              name: 'end_call',
              description: 'Hang up the phone call. Call this after saying goodbye, once the call objective is complete.',
            });
          }
          for (const t of this.connectorTools.values()) functionDeclarations.push(t.declaration);
          return functionDeclarations.length ? { tools: [{ functionDeclarations }] as any } : {};
        })(),
        // Tighten turn-taking: commit end-of-speech faster so the model starts
        // replying sooner after the caller stops. Lower silenceDurationMs =
        // snappier (too low risks cutting off mid-pause). Tunable via env.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity:
              liveCfg.startSensitivity === 'LOW'
                ? StartSensitivity.START_SENSITIVITY_LOW
                : StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            // Opted-out agents keep the original 50ms; see getLiveConfig for why
            // the default moved, and note every spurious turn re-bills the whole
            // window, so this knob is a cost knob as much as a quality one.
            prefixPaddingMs: this.optimize ? liveCfg.prefixPaddingMs : 50,
            silenceDurationMs: liveCfg.silenceMs,
          },
        },
        // Cost control. Live re-processes the entire session window on every
        // turn, so without this the input bill on a long call grows with the
        // square of its length — the dominant term in a call costing ~4x what
        // its raw audio minutes suggest.
        //
        // Compression does not drop the system instruction, but the trigger
        // COUNTS it: a booking agent's fixed prefix is ~3-4k tokens before the
        // caller says a word, so a trigger near that value fires on the first
        // turns of every call. See getLiveConfig — this is not theoretical, it
        // shipped and made the agent re-greet callers mid-call.
        // Trigger 0 disables it.
        //
        // Opted-out agents stay on the window they were tuned against. The
        // defaults tightened to 4000/2000, and an agent that has no backend
        // state re-injection (below) would just start forgetting.
        ...(() => {
          const trigger = this.optimize ? liveCfg.compressionTriggerTokens : LEGACY_COMPRESSION_TRIGGER;
          const target = this.optimize ? liveCfg.compressionTargetTokens : LEGACY_COMPRESSION_TARGET;
          return trigger > 0
            ? {
                contextWindowCompression: {
                  triggerTokens: String(trigger),
                  slidingWindow: { targetTokens: String(target) },
                },
              }
            : {};
        })(),
      },
      callbacks: {
        onopen: () => console.log('[live] gemini session open'),
        onmessage: (m) => this.onLiveMessage(m),
        onerror: (e) => console.error('[live] gemini error:', (e as any)?.message ?? e),
        onclose: (e) => {
          console.log('[live] gemini session closed', (e as any)?.code ?? '', (e as any)?.reason ?? '');
          // If the model socket dies while the caller is still on the line, the
          // agent is simply gone — no reconnect exists. Hanging up is honest;
          // leaving them holding a silent line is not.
          if (!this.closed) {
            console.warn('[live] model session closed mid-call — ending', this.callId);
            this.hardStop();
          }
        },
      },
    });

    // The connect itself can outlive the call. Checked here rather than only
    // before it, because this is where a session now exists to be leaked — and
    // where the greeting below would otherwise be generated, and billed, for a
    // caller who has already hung up.
    if (this.abandonedDuringSetup()) return;

    // Prompt the model to greet first (caller hasn't spoken yet).
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: 'The call has connected. Greet the caller now.' }] }],
      turnComplete: true,
    });
  }

  private onLiveMessage(m: LiveServerMessage) {
    // Token accounting. One report per turn, each covering that turn's whole
    // prompt — so this sum is what gets billed, not the final context size.
    // Read before the early returns below: usage rides along with tool calls
    // and interruptions too, and dropping those under-counts the call.
    if (m.usageMetadata) {
      accumulateUsage(this.usage, m.usageMetadata);
      this.maybeRestateContext(m.usageMetadata.promptTokenCount ?? 0);
    }

    // Gemini is about to drop the session — Live caps how long one can run.
    // Nothing here reconnects or resumes, so the alternative to ending the call
    // is the caller listening to silence until they give up and hang up.
    const goAway = (m as any).goAway;
    if (goAway) {
      console.warn('[live] gemini goAway', goAway.timeLeft ?? '', '- ending call', this.callId);
      this.hardStop();
      return;
    }

    // Tool calls: end_call hangs up; connector tools run their handler and
    // return a result the model speaks back.
    const toolCall = (m as any).toolCall;
    if (toolCall?.functionCalls?.length) {
      for (const fc of toolCall.functionCalls) {
        if (fc?.name === 'end_call') void this.doEndCall(fc.id);
        else if (this.connectorTools.has(fc?.name)) void this.handleConnectorTool(fc);
      }
      return;
    }

    const sc = m.serverContent;
    if (!sc) return;

    // Barge-in (model-detected): caller interrupted — flush Twilio's buffer.
    if (sc.interrupted) {
      console.log('[barge] model interrupted -> clear');
      this.agentAudioThisTurn = false;
      this.agentTurnStartedAt = 0;
      // The model has stopped generating of its own accord, so whatever audio
      // arrives next belongs to the new turn and must be allowed through.
      this.outputSuppressed = false;
      this.stopTyping(false); // its frames were already flushed by the clear
      this.sendClear();
    }

    // Audio out: forward each chunk to Twilio as mulaw frames.
    const parts = sc.modelTurn?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data) {
        // A reply the caller talked over. Its remaining chunks keep arriving —
        // sendClear only drops what the CARRIER had buffered, not what Gemini
        // is still streaming — and playing them is what made the agent lurch
        // back to life mid-sentence right after being cut off. Worse, the block
        // below would reset agentTurnStartedAt, restarting the 1.2s guard, so
        // the whole thing repeated for as long as the caller kept talking.
        if (this.outputSuppressed) continue;
        // First agent audio of this turn — stop the "thinking" typing and flush
        // any queued typing frames so they don't play over the reply.
        if (!this.agentAudioThisTurn) {
          this.agentAudioThisTurn = true;
          this.agentTurnStartedAt = Date.now();
          console.log(
            '[typing] agent audio start; gap since caller=' +
              (this.lastCallerInputAt ? Date.now() - this.lastCallerInputAt + 'ms' : 'n/a') +
              ' wasTyping=' + this.typingPlaying,
          );
          if (this.typingArmTimer) { clearTimeout(this.typingArmTimer); this.typingArmTimer = null; }
          if (this.typingPlaying) { this.stopTyping(true); }
        }
        this.sendAudioOut(Buffer.from(data, 'base64'));
      }
    }

    // Transcripts (for call history). Caller speech drives two things:
    //  1. Barge-in safety net — if the caller speaks WHILE the agent is talking,
    //     cut the agent immediately (don't wait on the model's own `interrupted`,
    //     which half-cascade models may send late or not at all).
    //  2. (Re)arm the typing "think gap" for after the caller pauses.
    if (sc.inputTranscription?.text) {
      this.callerText += sc.inputTranscription.text;
      // Emergency tripwire. Runs on the PARTIAL transcript, deliberately: the
      // model is already listening to this audio and may already be forming a
      // reply, so waiting for turnComplete would mean answering a chest-pain
      // report after the model had finished reassuring the caller about it.
      // Checked before barge-in and typing so nothing can return early past it.
      if (!this.emergencyFired) {
        const flag = detectRedFlag(this.callerText);
        if (flag) {
          this.emergencyFired = true;
          void this.handleEmergency(flag, this.callerText);
        }
      }
      // Barge-in safety net — only when the agent has genuinely been speaking
      // for a moment (>1.2s). gemini-3.1 emits the caller's transcript at the
      // SAME instant it starts replying, so without this guard every reply would
      // be falsely "interrupted" at its first audio chunk.
      if (this.agentAudioThisTurn && Date.now() - this.agentTurnStartedAt > 1200) {
        console.log('[barge] caller spoke mid-reply -> clear');
        this.agentAudioThisTurn = false;
        // Suppress the rest of this reply until the turn ends. We cannot cancel
        // the generation itself: activityEnd is only accepted when automatic
        // activity detection is DISABLED, and sending it while AAD is on is the
        // kind of invalid field that gets the session closed with a 1007 (see
        // the `audio` vs `media` note above). So Gemini finishes generating and
        // we still pay for it — but the caller stops hearing it, which is the
        // half that was actually broken.
        this.outputSuppressed = true;
        this.sendClear();
      }
      this.armTyping();
    }
    if (sc.outputTranscription?.text) this.agentText += sc.outputTranscription.text;

    if (sc.turnComplete) {
      this.agentAudioThisTurn = false;
      this.agentTurnStartedAt = 0;
      // The written-off reply has finished arriving; the next turn is the
      // caller's answer and must be heard.
      this.outputSuppressed = false;
      this.stopTyping(false);
      void this.flushTranscripts();
    }
  }

  // Hand the model back what it just forgot.
  //
  // Compression fires with no event to listen for. But every turn reports its
  // own prompt size, and within a session that only ever grows — until the
  // sliding window drops it. So a sharp fall IS the compression, observed for
  // free from the meter we already read, and it is the exact moment the caller's
  // name stopped being in context. One short line (see call-state.stateLine)
  // costs ~35 text tokens against the thousands of audio tokens just discarded.
  private maybeRestateContext(promptTokens: number) {
    const prev = this.lastPromptTokens;
    this.lastPromptTokens = promptTokens;
    // 0.7 rather than 1.0: a turn's prompt can dip slightly on its own (a short
    // tool-use prompt, a turn that carried no audio), and re-stating on every
    // such wobble would be noise the model has to read every time.
    if (!this.optimize || !prev || promptTokens >= prev * 0.7) return;

    // Includes the "do not greet again" guard unconditionally — see
    // restateAfterCompression for why that half matters more than the facts.
    const text = restateAfterCompression(this.callState);

    console.log('[live] window compressed', prev, '->', promptTokens, '- restating call context');
    try {
      // turnComplete:false adds context without asking for a reply — the same
      // way the emergency tripwire tells the model what it just said.
      this.session?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: false,
      });
    } catch {
      /* session closing; the next compression will try again */
    }
  }

  // Typing "thinking" sound — only between a caller turn and the agent's reply.
  private armTyping() {
    if (!this.typingEnabled) return;
    this.lastCallerInputAt = Date.now();
    // Caller is (still) talking: cancel any running/pending typing and re-arm.
    if (this.typingPlaying) this.stopTyping(true);
    this.agentAudioThisTurn = false;
    if (this.typingArmTimer) clearTimeout(this.typingArmTimer);
    // ~220ms after the caller's last transcription with no agent audio yet ≈
    // "caller finished, model is thinking" → start the ambience. (Kept short so
    // it fires before the agent's reply on faster half-cascade models.)
    this.typingArmTimer = setTimeout(() => {
      this.typingArmTimer = null;
      if (!this.agentAudioThisTurn) this.startTyping();
    }, 220);
  }

  private startTyping() {
    if (!this.typingEnabled || this.typingPlaying || this.closed || !this.streamSid) return;
    // The typing ambience buffer is mulaw/8k; skip it for non-mulaw providers.
    if (this.codec.deepgramEncoding !== 'mulaw') return;
    console.log('[typing] START (gap since caller stopped ~' + (Date.now() - this.lastCallerInputAt) + 'ms)');
    this.typingPlaying = true;
    this.typingFrameTimer = setInterval(() => {
      const buf = TYPING_MULAW_8K;
      if (this.typingPos + TYPING_FRAME_BYTES > buf.length) this.typingPos = 0;
      const frame = buf.subarray(this.typingPos, this.typingPos + TYPING_FRAME_BYTES);
      this.typingPos += TYPING_FRAME_BYTES;
      this.ws.send(JSON.stringify(buildMediaMessage(this.codec, this.streamSid, frame.toString('base64'))));
    }, 20);
    // Safety cap: never loop forever if the agent reply never arrives.
    this.typingStopTimer = setTimeout(() => this.stopTyping(true), 6000);
  }

  private stopTyping(flush: boolean) {
    const wasPlaying = this.typingPlaying;
    this.typingPlaying = false;
    if (this.typingFrameTimer) { clearInterval(this.typingFrameTimer); this.typingFrameTimer = null; }
    if (this.typingStopTimer) { clearTimeout(this.typingStopTimer); this.typingStopTimer = null; }
    if (this.typingArmTimer) { clearTimeout(this.typingArmTimer); this.typingArmTimer = null; }
    // Drop any queued typing frames from Twilio's buffer so they don't bleed
    // into the agent's speech.
    if (wasPlaying && flush) this.sendClear();
  }

  private async flushTranscripts() {
    const callId = this.callId;
    if (!callId) return;
    const caller = this.callerText.trim();
    const agentSaid = this.agentText.trim();
    this.callerText = '';
    this.agentText = '';
    try {
      if (caller) await recordTurn(callId, 'CALLER', caller, this.ms());
      if (agentSaid) await recordTurn(callId, 'AGENT', agentSaid, this.ms());
    } catch (err) {
      console.error('[live] transcript save failed', err);
    }
    if (caller) void this.maybeTransfer(caller);
  }

  // Human transfer: redirect the live call when the caller asks for a person.
  private async maybeTransfer(text: string) {
    const a = this.agent;
    if (this.transferring || !a?.transferEnabled || !a.transferNumber || !this.providerSid) return;
    if (!matchesTransferTrigger(text, a.transferTriggers)) return;
    this.transferring = true;
    const say = applyVariables(
      a.transferMessage?.trim() || 'Please hold while I connect you to a representative.',
      a.variables,
    );
    try {
      await (await providerForNumberId(this.phoneNumberId)).redirectCall(this.providerSid, { say, dial: a.transferNumber });
      console.log('[live] transferring call to', a.transferNumber);
    } catch (err) {
      console.error('[live] transfer failed:', err);
      this.transferring = false;
    }
  }

  // Gemini PCM16 24kHz -> provider wire audio, sent in codec-sized frames. Exotel
  // requires each chunk to be a multiple of 320 bytes, so the final partial chunk
  // is padded with silence.
  private sendAudioOut(pcm24: Buffer) {
    this.sendWireAudio(this.codec.encodeFromPcm24k(pcm24));
  }

  // Send audio that is ALREADY in the provider's wire format — used by the
  // emergency tripwire, whose speech comes from our own TTS rather than from
  // Gemini, so it never passes through encodeFromPcm24k.
  private sendWireAudio(wire: Buffer) {
    // Advance the playback clock by this chunk's real-time duration.
    const durMs = (wire.length / this.codec.wireBytesPerSec) * 1000;
    this.audioSentUntil = Math.max(Date.now(), this.audioSentUntil) + durMs;
    const frame = this.codec.frameBytes;
    for (let i = 0; i < wire.length; i += frame) {
      let chunk = wire.subarray(i, i + frame);
      if (this.provider === 'exotel' && chunk.length % 320 !== 0) {
        const padded = Buffer.alloc(Math.ceil(chunk.length / 320) * 320, this.codec.silenceByte);
        chunk.copy(padded);
        chunk = padded;
      }
      this.sendMedia(chunk.toString('base64'));
    }
  }

  // ── Emergency tripwire ─────────────────────────────────────────────────────
  // The caller has said something that may be a medical emergency. Cut the
  // model off and say so ourselves.
  //
  // Order matters and is the whole design:
  //   1. Silence the model FIRST, before any await. Everything after this can
  //      be slow; talking over a reassuring answer cannot wait on TTS.
  //   2. Speak from the fixed table, synthesized by our own TTS. The model is
  //      not consulted, so it cannot decline, soften or reword the number.
  //   3. Tell the clinic and the transcript (fire-and-forget, never blocking).
  //   4. Tell the model what happened so it doesn't contradict us afterwards.
  private async handleEmergency(flag: RedFlag, callerSaid: string) {
    console.warn(`[live] emergency tripwire fired (${flag.concept}) on call ${this.callId}`);
    // 1. Stop the agent talking, now.
    this.stopTyping(true);
    this.sendClear();

    const clinic = this.agent?.name || 'the clinic';
    const line = emergencySpokenReply(clinic, this.language);

    // 3. (started early so the clinic is told even if TTS is slow or fails)
    raiseVoiceEmergency(
      {
        callId: this.callId,
        orgId: this.orgId,
        workspaceId: this.agent?.workspaceId ?? null,
        agentId: this.agent?.id ?? null,
        clinicName: clinic,
        callerNumber: this.callerNumber,
        atMs: this.ms(),
      },
      flag,
      line,
      callerSaid,
    );

    // 2. Speak it. synthesizeTelephony always falls back to Google Cloud TTS,
    // so this only fails if every provider is unreachable — in which case the
    // model notice below is the last line of defence.
    try {
      const audio = await synthesizeTelephony(
        line,
        this.language,
        this.agent?.voice ?? '',
        this.agent?.voiceProvider ?? undefined,
        this.creds,
        this.codec.ttsEncoding,
      );
      if (!this.closed && audio.length) {
        // Clear once more: the model may have produced fresh audio during the
        // synthesis round trip, and it must not play over the top of this.
        this.sendClear();
        this.sendWireAudio(audio);
      }
    } catch (err) {
      console.error('[live] emergency TTS failed — falling back to the model', err);
    }

    // 4.
    try {
      this.session?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: emergencyModelNotice() }] }],
        turnComplete: false,
      });
    } catch {
      /* session may be closing; the caller has already heard the line */
    }
  }

  // Build a provider-correct media message (Twilio/Exotel `media` vs Plivo
  // `playAudio`).
  private sendMedia(payloadBase64: string) {
    this.ws.send(JSON.stringify(buildMediaMessage(this.codec, this.streamSid, payloadBase64)));
  }

  private sendClear() {
    // The provider drops its buffered audio, so the playback clock resets too.
    this.audioSentUntil = 0;
    const msg = buildClearMessage(this.codec, this.streamSid);
    if (msg) this.ws.send(JSON.stringify(msg));
  }

  // Run a connector tool the model invoked, then return its result so the model
  // can speak it. Errors are returned as a tool result (not thrown) so the agent
  // can recover gracefully on the call.
  private async handleConnectorTool(fc: { id?: string; name?: string; args?: Record<string, unknown> }) {
    const tool = fc?.name ? this.connectorTools.get(fc.name) : undefined;
    if (!tool || !this.connectorCtx || !this.callId || !this.agent) return;
    const key = LiveCallSession.ONCE_PER_CALL.has(fc.name ?? '')
      ? `${fc.name}`
      : `${fc.name}:${JSON.stringify(fc.args ?? {})}`;
    const once = LiveCallSession.WRITE_ONCE.has(fc.name ?? '');
    let response: Record<string, unknown>;
    try {
      // A model that asks for the same write twice must not get it twice. On a
      // live call it does: an agent saved one caller's enquiry twice, 1.5s
      // apart, byte-identical args, and the caller got two WhatsApps. The
      // prompt said not to; prompts do not enforce.
      //
      // A retry after "still need: pincode" still runs, because a FAILED call
      // releases its key below — that, rather than the arguments differing, is
      // what keeps a half-collected enquiry saveable.
      // The first invocation's PROMISE is what repeats resolve to, because the
      // dispatcher fires these off with `void` — two calls arriving in one
      // toolCall message run concurrently, and a "has it already happened?"
      // check would race between them.
      const inflight = once ? this.toolOnce.get(key) : undefined;
      if (inflight) {
        console.log('[live] duplicate', fc.name, 'call — returning the first result');
        response = await inflight;
      } else {
        const p = tool.handler(fc.args ?? {}, {
          orgId: this.connectorCtx.orgId,
          callId: this.callId,
          customerNumber: this.connectorCtx.customerNumber,
          agent: this.agent,
        });
        if (once) this.toolOnce.set(key, p);
        response = await p;
        // A write that FAILED has changed nothing, so it must stay retryable —
        // otherwise one transient database error becomes an enquiry that can
        // never be saved for the rest of the call.
        if (once && response?.ok === false) this.toolOnce.delete(key);
      }
    } catch (err) {
      if (once) this.toolOnce.delete(key);
      console.error('[live] connector tool error', fc?.name, err);
      response = { ok: false, error: 'The action failed. Apologize and offer to take a message.' };
    }
    // Every fact the caller gives arrives through a tool call, so this is where
    // the backend gets to keep it — see call-state.ts. Recorded even when the
    // handler failed: the caller still said what they said.
    this.callState = updateFromTool(this.callState, fc.name, fc.args, response);
    try {
      this.session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
    } catch (err) {
      console.error('[live] sendToolResponse failed', err);
    }
  }

  // #3: end the call when the model calls end_call. Hang up via the provider;
  // finalize() runs on the resulting socket close.
  private async doEndCall(fcId?: string) {
    if (this.closed || this.endingCall) return;
    this.endingCall = true;
    console.log('[live] agent ended call (end_call)');
    // Ack the tool call so the model isn't left waiting mid-hangup.
    try {
      this.session?.sendToolResponse({ functionResponses: [{ id: fcId, name: 'end_call', response: { ok: true } }] });
    } catch {
      /* session may already be closing */
    }
    // Let the goodbye finish playing before cutting the line. The model calls
    // end_call while seconds of its speech are still buffered at the provider
    // (audio streams faster than realtime), so wait out the playback clock —
    // which keeps extending while goodbye chunks are still arriving. The
    // initial wait covers the model calling the tool BEFORE speaking.
    await new Promise((r) => setTimeout(r, 1000));
    const deadline = Date.now() + 15000; // hard cap — never stall the hangup
    for (;;) {
      const remainingMs = this.audioSentUntil - Date.now();
      if (remainingMs <= 0 || Date.now() >= deadline || this.closed) break;
      await new Promise((r) => setTimeout(r, Math.min(remainingMs, 400)));
    }
    if (this.closed) return;
    // Small pad for network + the provider's jitter buffer.
    await new Promise((r) => setTimeout(r, 600));
    if (this.closed) return;
    try {
      if (this.providerSid) await (await providerForNumberId(this.phoneNumberId)).redirectCall(this.providerSid, { hangup: true });
    } catch (err) {
      console.error('[live] end_call hangup failed:', err);
    }
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    // Guaranteed fallback: closing the media socket ends the stream — and with
    // it the call — even when the provider API hangup is unavailable (Exotel)
    // or failed, or providerSid is missing. Also triggers finalize().
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private async finalize() {
    if (this.closed) return;
    this.closed = true;
    this.clearWatchdogs();
    this.stopTyping(false);
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    const callId = this.callId;
    if (!callId) return;
    // Logged as well as stored: a call that dies before finalize can persist
    // still leaves its cost in the voice-server log.
    const costInr = estimateCostInr(this.usage, this.liveModel);
    console.log(
      '[usage] call:', callId,
      'model:', this.liveModel,
      'sec:', Math.round(this.ms() / 1000),
      'turns:', this.usage.turns,
      'in:', this.usage.promptTokens, `(audio ${this.usage.audioInTokens})`,
      'out:', this.usage.responseTokens, `(audio ${this.usage.audioOutTokens})`,
      'est INR:', costInr,
    );
    try {
      await finalizeCallRecord(callId, this.ms(), { usage: this.usage, model: this.liveModel, costInr });
    } catch (err) {
      console.error('[live] finalize failed', err);
    }
  }
}
