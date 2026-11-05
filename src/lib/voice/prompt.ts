import { languageStyleInstruction, agentTypeLabel } from '@/lib/constants';
import { fallbackInstruction } from '@/lib/agent-behavior';
import { whatsappEnabled } from '@/lib/flags';

// #4: single source of truth for the Gemini Live system instruction. Both the
// live call pipeline (src/lib/voice/live.ts) and the admin "exact prompt &
// parameters" preview call composeSystemInstruction, so what the founder sees in
// /admin is byte-for-byte what the model receives.

// One field the owner configured the agent to collect, from outcomeConfig.
export type CaptureField = { key: string; label: string; required?: boolean };

export type PromptParts = {
  // Admin-editable base prompt prepended to every agent (may be null).
  basePrompt: string | null;
  // The agent's own system prompt (variables already applied) — or, for the
  // shared demo line, the platform-knowledge persona.
  corePrompt: string;
  // Retrieved knowledge block (empty string when none / demo).
  knowledge: string;
  languageMode: string;
  language: string;
  fallbackMessage: string | null;
  // Auto end-call instructions (empty/null disables the end_call tool).
  endCallInstructions?: string | null;
  // Admin-editable spoken-call guidance (the phone-call persona wording).
  callGuidance: string;
  greeting: string;
  // Compliance: agent must announce at the start that the call may be recorded.
  recordingDisclosure?: boolean;
  // Details the owner configured the agent to collect (outcomeConfig.captures).
  captures?: CaptureField[];
  // The practice type chosen at setup, plus the free-text label used when it is "other".
  agentType?: string | null;
  industryLabel?: string | null;
  // Appointment guidance, present only when the booking tools are registered.
  // Lives here rather than being appended by the caller so the admin preview
  // shows what a booking agent actually receives — it is the single largest
  // block in the instruction, and it used to be invisible there.
  booking?: BookingPromptParts | null;
};

export type BookingPromptParts = {
  /** Current date and time, already formatted in the business's timezone. */
  nowInTz: string;
  todayIso: string;
  timezone: string;
  /**
   * Whether to use the short form. The long form spells out how to read slots
   * back to the caller; on the cost-optimised path that guidance travels on the
   * check_availability RESULT instead (see connectors/booking.ts `say`), where
   * it is paid for once per lookup rather than on every turn of the call.
   */
  concise: boolean;
};

// Recording-consent disclosure (two-party-consent states, Indian enterprise
// policies). Kept as one fixed sentence so what callers hear is predictable.
export function recordingDisclosureClause(enabled: boolean | undefined): string {
  return enabled
    ? '\n\nRECORDING DISCLOSURE: In your very first sentence of the call — before anything else — ' +
        'inform the caller that this call may be recorded for quality and training purposes. ' +
        'Say it once, briefly and naturally, then continue with the greeting.'
    : '';
}

export function endCallClause(endCallInstructions: string | null | undefined): string {
  const instr = endCallInstructions?.trim();
  return instr
    ? `\n\nEnd the call when: ${instr}. When that's satisfied, say a brief goodbye, then CALL the end_call function to hang up.`
    : '';
}

// Callers are only ever contacted by text message (there is no email channel),
// so no agent may promise an email regardless of what its own prompt says.
// While the WhatsApp feature flag is off, the only channel is SMS.
export function messagingClause(): string {
  const channels = whatsappEnabled() ? 'WhatsApp or SMS text message' : 'SMS text message';
  return (
    `\n\nMESSAGING: Any confirmations or follow-ups are sent to the caller by ${channels} only. ` +
    'Never offer to email the caller or say anything will be sent by email.'
  );
}

// The practice type picked at setup drove the vertical templates, outcome tagging
// and the UI label — but never reached the model, so choosing "Dental Clinic"
// changed nothing about how the agent spoke. One line of setting is enough for it
// to use the right vocabulary.
export function practiceClause(agentType: string | null | undefined, industryLabel?: string | null): string {
  const type = agentType?.trim();
  if (!type) return '';
  const custom = industryLabel?.trim();
  const label = type === 'other' && custom ? custom : agentTypeLabel(type);
  return (
    `\n\nWHERE YOU WORK: You are answering the phone for a ${label}. ` +
    'Use the vocabulary and expectations of that setting, and treat questions outside it as things to take a message about ' +
    'rather than answer yourself.'
  );
}

// The details an owner ticked in "Messages & Alerts" used to exist in exactly one
// place: as parameters on the record_outcome tool. That tool is suppressed
// whenever booking is active (src/lib/connectors/tools.ts — two overlapping
// "save this" tools confuse the model), so an agent with bookings switched on
// was never told to ask for the caller's name at all. Saying it in the
// instruction makes the ask survive whichever tool set gets registered.
export function captureClause(captures: CaptureField[] | undefined): string {
  const list = (captures ?? []).filter((c) => c && c.key?.trim() && c.label?.trim());
  if (!list.length) return '';

  const required = list.filter((c) => c.required).map((c) => c.label.trim());
  const optional = list.filter((c) => !c.required).map((c) => c.label.trim());

  const parts: string[] = [];
  if (required.length) parts.push(`${required.join(', ')} (always ask)`);
  if (optional.length) parts.push(`${optional.join(', ')} (ask if it comes up naturally)`);

  return (
    `\n\nDETAILS TO COLLECT: ${parts.join('; ')}. ` +
    'Ask for anything you do not already have before the call ends, one item at a time so it still sounds like a ' +
    'conversation rather than a form. Never invent or assume a value — if the caller will not give it, continue without it.'
  );
}

// The model has no clock. Without being told the date it cannot turn "next
// Monday" or "the 14th" into the YYYY-MM-DD that check_availability wants, so it
// simply never passed one — and silently got near-term slots back.
export function bookingClause(b: BookingPromptParts | null | undefined): string {
  if (!b) return '';
  const today =
    `\n\nTODAY: It is currently ${b.nowInTz} (${b.timezone}). Today's date is ${b.todayIso}. ` +
    'Work out every date the caller mentions from this, and never ask them what today is.';

  if (b.concise) {
    return (
      today +
      '\n\nAPPOINTMENTS: Call check_availability before offering any time — pass date whenever the caller ' +
      'names a day and time whenever they name an hour. Offer only times it returns; never invent one, and ' +
      'follow the `say` field in its reply. Once they pick one, call book_appointment with that exact ' +
      "startISO and the caller's name. To change or cancel, call find_appointment first for the id. " +
      'Confirmations are sent on WhatsApp — never say they will be emailed.'
    );
  }

  return (
    today +
    '\n\nAPPOINTMENT BOOKING: You can manage real appointments. To BOOK: call check_availability for open times, ' +
    'passing the date argument whenever the caller names a day AND the time argument whenever they name an hour. ' +
    'If they asked for a specific time, the reply tells you whether that exact time is free: when ' +
    'requestedTimeAvailable is true, offer THAT time back to them rather than reading out a list — they ' +
    'already told you what they wanted. When it is false, say that time is taken and offer the nearest ' +
    'ones it returned. If the caller has NOT named a time, do not read out a list of slot times — tell them ' +
    'the hours the clinic is open that day, which comes back as hours.label, and ask what time would suit ' +
    'them. Only offer specific times when they say they have no preference. If it returns no slots for that date, say that day ' +
    'is full and offer to check another — never quietly read out times from a different day. Otherwise ' +
    'read out one or two options, then once the caller picks one call book_appointment with the exact startISO it ' +
    'returned and the caller’s name. To RESCHEDULE or CANCEL: call find_appointment to get the caller’s booking and ' +
    'its appointmentId, then call reschedule_appointment (with a new startISO from check_availability) or ' +
    'cancel_appointment. Always confirm the result back to the caller. Never invent or guess times — only offer what ' +
    'check_availability returns. After booking, a confirmation is sent to the caller automatically as a ' +
    'WhatsApp message' +
    ' — tell them to expect it there. Never say it will be emailed.'
  );
}

export function composeSystemInstruction(p: PromptParts): string {
  const basePrefix = p.basePrompt ? p.basePrompt.trim() + '\n\n' : '';
  return (
    basePrefix +
    p.corePrompt +
    practiceClause(p.agentType, p.industryLabel) +
    p.knowledge +
    languageStyleInstruction(p.languageMode, p.language) +
    fallbackInstruction(p.fallbackMessage) +
    messagingClause() +
    captureClause(p.captures) +
    endCallClause(p.endCallInstructions) +
    recordingDisclosureClause(p.recordingDisclosure) +
    `\n\n${p.callGuidance.trim()} ` +
    `Begin the call by greeting the caller, for example: "${p.greeting}"` +
    // Last, exactly where live.ts used to append it, so an opted-out agent's
    // instruction is byte-for-byte what it was.
    bookingClause(p.booking)
  );
}
