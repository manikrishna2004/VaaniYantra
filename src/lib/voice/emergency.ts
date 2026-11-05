import { detectRedFlag, emergencySpokenReply, type RedFlag } from '@/lib/portal/red-flags';
import { alertEmergency } from '@/lib/portal/emergency-alert';
import { recordTurn } from '@/lib/voice/conversation';

// The emergency tripwire on the PHONE.
//
// The chat channels get a real pre-empt: the patient's whole message is in hand
// before the model is called, so the model never sees it. A phone call cannot
// always offer that, and pretending otherwise would be the dangerous kind of
// tidy. There are two pipelines and they get two different guarantees:
//
//   Cascade (Deepgram STT -> Gemini -> TTS)
//     A PRE-EMPT, identical to chat. The caller's utterance is transcribed in
//     full and handed to processTurn() before any model call, so we can answer
//     it ourselves and return.
//
//   Gemini Live (realtime speech-to-speech)
//     An INTERRUPT. Audio streams continuously to the model, which may already
//     be replying by the time the transcript of those words reaches us — there
//     is no point at which we hold the text. So we detect on the partial
//     transcript as it arrives, cut the model's audio mid-word, and speak over
//     it. The caller may hear a syllable or two of the model first.
//
// Both are enormously better than the status quo, which was a line in the
// system prompt. A prompt instruction is advisory, competes with everything
// else in a long prompt, and fails precisely when the model has decided to be
// reassuring. Neither path below asks the model for anything.
//
// The spoken line itself is synthesized from a fixed table (red-flags.ts), not
// generated — see the note there. The clinic alert reuses the same throttle as
// the chat channels so one caller cannot flood a practice's notifications.

export { detectRedFlag, emergencySpokenReply };
export type { RedFlag };

export type VoiceEmergencyContext = {
  callId: string | null;
  orgId: string | null;
  workspaceId: string | null;
  agentId: string | null;
  /** Business name, as spoken to the caller and shown to the clinic. */
  clinicName: string;
  /** The caller's number, for the clinic to ring back. */
  callerNumber: string | null;
  /** Milliseconds into the call, for the transcript entry. */
  atMs: number;
};

/**
 * Everything that happens around the spoken line: the clinic's alert and the
 * transcript record.
 *
 * Deliberately returns void and swallows everything. The caller has already
 * been given 108/112 by the time this runs — or is about to be, on the same
 * tick — and nothing here may delay, block or throw into that path. A clinic
 * that misses an alert is a bad day; a caller who hears silence instead of an
 * ambulance number is the failure this whole mechanism exists to prevent.
 */
export function raiseVoiceEmergency(
  ctx: VoiceEmergencyContext,
  flag: RedFlag,
  spokenTo: string,
  callerSaid: string,
): void {
  if (ctx.orgId && ctx.workspaceId) {
    void alertEmergency({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      channel: 'voice',
      ref: ctx.callId ?? 'unknown-call',
      patientName: null,
      patientPhone: ctx.callerNumber,
      businessName: ctx.clinicName,
      agentId: ctx.agentId,
      text: callerSaid,
      flag,
    });
  } else {
    // A demo or unresolved call still gets the spoken reply; it just has no
    // clinic to notify. Log it so the firing is never invisible.
    console.warn(
      `[emergency] ${flag.concept} on call ${ctx.callId ?? 'unknown'} with no org context — spoken reply only`,
    );
  }

  // Record what we said as an AGENT turn so the clinic reviewing the call sees
  // the emergency line in the transcript rather than an unexplained gap.
  if (ctx.callId) {
    void recordTurn(ctx.callId, 'AGENT', spokenTo, ctx.atMs).catch((err) =>
      console.error('[emergency] transcript record failed', err),
    );
  }
}

/**
 * What the model is told after we have spoken over it.
 *
 * Not a request for help — the caller already has the number. It exists so the
 * model does not immediately contradict us, re-answer the symptom, or carry on
 * as though the interruption never happened.
 */
export function emergencyModelNotice(): string {
  return (
    '[system] The caller described a possible medical emergency. They have ALREADY been told, ' +
    'in a message they heard, to hang up and call 108 or 112. Do not repeat medical advice, do not ' +
    'diagnose, and do not contradict that instruction. If they keep talking, stay calm and brief, ' +
    'and encourage them to call the emergency number or come in.'
  );
}
