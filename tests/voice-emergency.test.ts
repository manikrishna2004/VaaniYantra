import { describe, it, expect, vi, beforeEach } from 'vitest';

// The emergency tripwire on the phone.
//
// Chat gets a pre-empt — the message is in hand before the model runs. A
// Gemini Live call cannot offer that: audio streams continuously and the model
// may already be answering by the time we see the transcript of those words.
// So the guarantee here is an INTERRUPT, and these tests hold it to that:
//
//   - the model's audio is cut BEFORE anything that can block (TTS, DB, alert)
//   - the spoken line comes from the fixed table via our own TTS, never the model
//   - it fires on the partial transcript, not on turnComplete
//   - it fires once per call
//   - every failure mode still leaves the caller having heard the number
//
// Previously none of this existed: a caller saying "chest pain" to the phone
// agent was protected only by a sentence in the system prompt.

// Typed to match the real signatures so the argument assertions below are
// checked rather than inferred as never.
const synthesizeTelephony = vi.hoisted(() =>
  vi.fn(
    async (
      _text: string,
      _language: string,
      _voiceId: string,
      _voiceProvider?: string,
      _creds?: unknown,
      _encoding?: string,
    ) => Buffer.alloc(1600, 0x7f), // 200ms of mulaw/8k
  ),
);
const alertEmergency = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => {}));
const recordTurn = vi.hoisted(() =>
  vi.fn(async (_callId: string, _role: string, _text: string, _atMs: number) => {}),
);

vi.mock('@/lib/voice/tts', () => ({ synthesizeTelephony }));
vi.mock('@/lib/portal/emergency-alert', () => ({
  alertEmergency,
  EMERGENCY_OUTCOME_TYPE: 'emergency',
}));
vi.mock('@/lib/voice/conversation', () => ({
  recordTurn,
  summarizeCall: vi.fn(async () => {}),
  generateAgentTurn: vi.fn(),
  generateAgentTurnStreaming: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { call: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock('@/lib/rag/retrieve', () => ({
  retrieveForAgent: vi.fn(async () => []),
  formatKnowledgeBlock: vi.fn(() => ''),
}));
vi.mock('@/lib/webhooks', () => ({ dispatchCallEvent: vi.fn() }));
vi.mock('@/lib/crm', () => ({ pushCallToCrm: vi.fn() }));
vi.mock('@/lib/voice/finalize', () => ({ finalizeCallRecord: vi.fn() }));
vi.mock('@/lib/connectors/tools', () => ({ getCallConnectorTools: vi.fn(async () => []) }));
vi.mock('@/lib/telephony-accounts', () => ({ providerForNumberId: vi.fn() }));
vi.mock('@/lib/integrations', () => ({ getOrgCredentials: vi.fn(async () => ({})) }));

import { LiveCallSession } from '@/lib/voice/live';
import { emergencySpokenReply, raiseVoiceEmergency } from '@/lib/voice/emergency';

type SentMessage = { event?: string; media?: { payload?: string } };

function makeSession() {
  const sent: SentMessage[] = [];
  const ws = {
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    on: vi.fn(),
    close: vi.fn(),
  };
  const s = new LiveCallSession(ws as any, 'call_1', 'twilio');
  const priv = s as any;
  priv.streamSid = 'MZ_stream';
  priv.agent = {
    id: 'a1',
    workspaceId: 'w1',
    name: 'Sunrise Dental',
    language: 'en-IN',
    voice: 'en-IN-Neural2-A',
    voiceProvider: 'google',
  };
  priv.orgId = 'o1';
  priv.callerNumber = '+919876543210';
  priv.language = 'en-IN';
  priv.session = { sendClientContent: vi.fn(), close: vi.fn() };
  return { s, priv, ws, sent };
}

/** Feed one chunk of caller transcript, as Gemini Live delivers it. */
const hear = (priv: any, text: string) =>
  priv.onLiveMessage({ serverContent: { inputTranscription: { text } } });

const eventsOf = (sent: SentMessage[]) => sent.map((m) => m.event);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Gemini Live — the tripwire interrupts the model', () => {
  it('does nothing at all for ordinary speech', async () => {
    const { priv, sent } = makeSession();

    hear(priv, 'hello, I would like to book a cleaning next Tuesday');
    await vi.waitFor(() => expect(priv.emergencyFired).toBe(false));

    expect(synthesizeTelephony).not.toHaveBeenCalled();
    expect(eventsOf(sent)).not.toContain('clear');
  });

  it('cuts the model and speaks the emergency line', async () => {
    const { priv, sent } = makeSession();

    hear(priv, 'I am having really bad chest pain');
    await vi.waitFor(() => expect(synthesizeTelephony).toHaveBeenCalled());

    const spoken = synthesizeTelephony.mock.calls[0][0];
    expect(spoken).toContain('108');
    expect(spoken).toContain('112');
    expect(spoken).toContain('Sunrise Dental');
    // Audio actually went to the caller.
    await vi.waitFor(() => expect(eventsOf(sent)).toContain('media'));
  });

  it('silences the model BEFORE it starts synthesizing', async () => {
    // The ordering is the whole design: TTS is a network round trip, and the
    // model must not be allowed to keep reassuring the caller during it.
    const { priv, sent } = makeSession();
    let clearedBeforeTts = false;
    synthesizeTelephony.mockImplementationOnce(async () => {
      clearedBeforeTts = eventsOf(sent).includes('clear');
      return Buffer.alloc(1600, 0x7f);
    });

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(synthesizeTelephony).toHaveBeenCalled());

    expect(clearedBeforeTts).toBe(true);
  });

  it('fires on the accumulating partial transcript, not on turn completion', async () => {
    // Gemini emits the caller's words in fragments while the model is already
    // forming its reply. Waiting for turnComplete would answer the emergency
    // only after the model had finished talking about it.
    const { priv } = makeSession();

    hear(priv, 'I think ');
    hear(priv, 'I am having ');
    expect(priv.emergencyFired).toBe(false);
    hear(priv, 'chest pain');

    await vi.waitFor(() => expect(priv.emergencyFired).toBe(true));
    expect(synthesizeTelephony).toHaveBeenCalled();
  });

  it('fires only once per call', async () => {
    const { priv } = makeSession();

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(synthesizeTelephony).toHaveBeenCalledTimes(1));

    priv.callerText = '';
    hear(priv, 'still severe chest pain and bleeding');
    hear(priv, 'I cannot breathe');
    await new Promise((r) => setTimeout(r, 10));

    // Repeating it would talk over a caller who is trying to hang up and dial.
    expect(synthesizeTelephony).toHaveBeenCalledTimes(1);
  });

  it('tells the clinic, tagged as a voice call', async () => {
    const { priv } = makeSession();

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(alertEmergency).toHaveBeenCalled());

    expect(alertEmergency.mock.calls[0][0]).toMatchObject({
      channel: 'voice',
      orgId: 'o1',
      workspaceId: 'w1',
      patientPhone: '+919876543210',
      ref: 'call_1',
    });
  });

  it('puts the spoken line in the transcript', async () => {
    const { priv } = makeSession();

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(recordTurn).toHaveBeenCalled());

    // Otherwise the clinic reviewing the call sees an unexplained gap.
    const [, role, text] = recordTurn.mock.calls[0];
    expect(role).toBe('AGENT');
    expect(text).toContain('108');
  });

  it('warns the model afterwards so it does not contradict us', async () => {
    const { priv } = makeSession();

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(priv.session.sendClientContent).toHaveBeenCalled());

    const arg = priv.session.sendClientContent.mock.calls[0][0];
    expect(JSON.stringify(arg)).toContain('108');
  });

  it('does not throw when TTS fails outright', async () => {
    // Every provider unreachable. The call must survive; the model notice is
    // then the only remaining mitigation.
    const { priv } = makeSession();
    synthesizeTelephony.mockRejectedValueOnce(new Error('all TTS providers down'));

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(priv.session.sendClientContent).toHaveBeenCalled());

    expect(priv.emergencyFired).toBe(true);
  });

  it('still speaks when there is no org to alert (demo call)', async () => {
    const { priv } = makeSession();
    priv.orgId = null;

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(synthesizeTelephony).toHaveBeenCalled());

    expect(alertEmergency).not.toHaveBeenCalled();
  });

  it('uses the caller-facing wire encoding for the provider', async () => {
    const { priv } = makeSession();

    hear(priv, 'chest pain');
    await vi.waitFor(() => expect(synthesizeTelephony).toHaveBeenCalled());

    // Twilio takes mulaw; sending PCM would be audible garbage at the worst
    // possible moment.
    expect(synthesizeTelephony.mock.calls[0][5]).toBe('mulaw');
  });
});

describe('the spoken line is written for a phone, not a chat window', () => {
  it('leads with the action and names both numbers', () => {
    const line = emergencySpokenReply('Sunrise Dental', 'en-IN');
    expect(line).toContain('108');
    expect(line).toContain('112');
    expect(line.toLowerCase()).toContain('hang up');
  });

  it('has no line breaks — TTS reads them as nothing', () => {
    for (const lang of ['en-IN', 'hi-IN', 'ta-IN', null]) {
      expect(emergencySpokenReply('Clinic', lang)).not.toContain('\n');
    }
  });

  it('falls back to English for a language with no translation', () => {
    for (const lang of ['ta-IN', 'te-IN', 'bn-IN', 'fr-FR', '', null, undefined]) {
      const line = emergencySpokenReply('Clinic', lang);
      expect(line, String(lang)).toContain('108');
      expect(line, String(lang)).toContain('112');
    }
  });

  it('speaks Hindi when the agent speaks Hindi', () => {
    const line = emergencySpokenReply('Clinic', 'hi-IN');
    expect(line).toContain('108');
    expect(line).toMatch(/[ऀ-ॿ]/);
  });

  it('does not diagnose', () => {
    const line = emergencySpokenReply('Clinic', 'en-IN').toLowerCase();
    for (const scary of ['heart attack', 'stroke', 'you may be having', 'dying']) {
      expect(line).not.toContain(scary);
    }
  });

  it('names the clinic generically when it has none', () => {
    expect(emergencySpokenReply('', 'en-IN')).toContain('the clinic');
  });
});

describe('raiseVoiceEmergency never breaks the call', () => {
  const ctx = {
    callId: 'call_1',
    orgId: 'o1',
    workspaceId: 'w1',
    agentId: 'a1',
    clinicName: 'Sunrise Dental',
    callerNumber: '+919876543210',
    atMs: 4200,
  };
  const flag = { concept: 'chest_pain', matched: 'chest pain' } as any;

  it('does not throw when alerting rejects', async () => {
    alertEmergency.mockRejectedValueOnce(new Error('db down'));
    expect(() => raiseVoiceEmergency(ctx, flag, 'spoken', 'chest pain')).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('does not throw when the transcript write rejects', async () => {
    recordTurn.mockRejectedValueOnce(new Error('db down'));
    expect(() => raiseVoiceEmergency(ctx, flag, 'spoken', 'chest pain')).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('does not throw without a call id', () => {
    expect(() =>
      raiseVoiceEmergency({ ...ctx, callId: null }, flag, 'spoken', 'chest pain'),
    ).not.toThrow();
  });
});
