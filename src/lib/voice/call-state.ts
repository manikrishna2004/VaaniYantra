// What the backend knows about a call, held outside the model's context.
//
// Why this exists: Live re-bills the whole accumulated window on every turn, so
// the window has to be kept small — and a small window means the model forgets
// what the caller said early on. Their name, the day they asked for, the slot
// they just agreed to: all of it scrolls out of a 2000-token window inside a
// minute, and an agent that re-asks for a name it was already given sounds
// broken.
//
// So the facts live here instead. Every one of them arrives through a tool call
// (that is what the tools are for), which means the backend already sees them —
// it just used to throw them away. live.ts folds each call through
// updateFromTool, and re-injects stateLine() as ~35 tokens the moment it sees
// the window slide. The model does not have to remember; it has to be told once,
// cheaply, at the point it would otherwise have forgotten.
//
// Nothing here is authoritative for business purposes: the appointment row is
// still the source of truth for what was booked. This is the conversation's
// working memory, and only that.

export type CallState = {
  customerName?: string;
  expert?: string;
  /** What the caller asked for, as passed to check_availability. */
  requestedDate?: string; // YYYY-MM-DD
  requestedTime?: string; // HH:MM
  /** What they actually got. */
  selectedSlotLabel?: string;
  appointmentId?: string;
  /** Owner-configured captures already collected, from record_outcome. */
  details?: Record<string, string>;
};

export function emptyCallState(): CallState {
  return {};
}

/** Coerce a tool argument to a trimmed string, or undefined if it isn't usable. */
function str(v: unknown, max = 60): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
}

// Capture keys that mean "the caller's name". Owners name these fields
// themselves, so this is a best-effort match, not a contract.
const NAME_KEYS = new Set(['name', 'customername', 'callername', 'patientname', 'fullname']);

/**
 * Fold one tool call — its arguments and its result — into the call state.
 *
 * Arguments matter as much as results: `check_availability(date, time)` is the
 * only place the caller's stated preference is ever written down, and it is
 * recorded whether or not that time turned out to be free.
 *
 * Pure: returns a new object, so a handler that throws cannot leave the state
 * half-updated.
 */
export function updateFromTool(
  state: CallState,
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
): CallState {
  const a = args ?? {};
  const r = response ?? {};
  const next: CallState = { ...state, ...(state.details ? { details: { ...state.details } } : {}) };

  // A tool that failed tells us nothing about the world, but the caller still
  // said what they said — so arguments are folded in regardless, results only
  // when the call succeeded.
  const ok = r.ok !== false;

  switch (name) {
    case 'check_availability': {
      next.requestedDate = str(a.date) ?? next.requestedDate;
      next.requestedTime = str(a.time) ?? next.requestedTime;
      next.expert = str(a.expert) ?? next.expert;
      break;
    }
    case 'book_appointment': {
      next.customerName = str(a.customerName) ?? next.customerName;
      next.expert = str(a.expert) ?? next.expert;
      if (ok && r.booked) {
        next.appointmentId = str(r.appointmentId, 40) ?? next.appointmentId;
        next.selectedSlotLabel = str(r.when, 80) ?? next.selectedSlotLabel;
      }
      break;
    }
    case 'find_appointment': {
      const list = Array.isArray(r.appointments) ? r.appointments : [];
      const first = list[0] as Record<string, unknown> | undefined;
      if (ok && first) {
        next.appointmentId = str(first.appointmentId, 40) ?? next.appointmentId;
        next.selectedSlotLabel = str(first.when, 80) ?? next.selectedSlotLabel;
        next.expert = str(first.expert) ?? next.expert;
      }
      break;
    }
    case 'reschedule_appointment': {
      if (ok && r.rescheduled) {
        next.appointmentId = str(a.appointmentId, 40) ?? next.appointmentId;
        next.selectedSlotLabel = str(r.when, 80) ?? next.selectedSlotLabel;
      }
      break;
    }
    case 'cancel_appointment': {
      // Deliberately cleared: leaving a cancelled booking in the state is how an
      // agent ends up confirming an appointment that no longer exists.
      if (ok && r.cancelled) {
        next.appointmentId = undefined;
        next.selectedSlotLabel = undefined;
      }
      break;
    }
    case 'record_outcome': {
      // The schema is owner-defined, so take every string argument as a fact the
      // caller has already given — that is exactly what must not be asked twice.
      for (const [k, v] of Object.entries(a)) {
        const val = str(v, 80);
        if (!val) continue;
        next.details = { ...(next.details ?? {}), [k]: val };
        if (NAME_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, ''))) next.customerName = val;
      }
      break;
    }
    default:
      break;
  }

  return next;
}

// Hard cap on the rendered line. This gets re-sent on every compression, so it
// must stay a rounding error against the window it is protecting — a state line
// that grew to hundreds of tokens would be re-billed exactly like the context we
// just compressed away.
const MAX_CHARS = 320;

/**
 * Render the state as one short line for the model, or '' when nothing is known.
 *
 * Phrased as an assertion of fact rather than an instruction: the model is being
 * reminded what it already established, not told to do something with it.
 */
export function stateLine(state: CallState): string {
  const parts: string[] = [];
  if (state.customerName) parts.push(`caller's name is ${state.customerName}`);
  if (state.expert) parts.push(`they asked for ${state.expert}`);
  if (state.requestedDate || state.requestedTime) {
    parts.push(
      `they asked about ${[state.requestedDate, state.requestedTime].filter(Boolean).join(' at ')}`,
    );
  }
  if (state.selectedSlotLabel) {
    parts.push(
      state.appointmentId
        ? `their appointment is booked for ${state.selectedSlotLabel}`
        : `the time under discussion is ${state.selectedSlotLabel}`,
    );
  }
  for (const [k, v] of Object.entries(state.details ?? {})) {
    if (NAME_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, ''))) continue; // already said
    parts.push(`${k}: ${v}`);
  }
  if (!parts.length) return '';

  return `EARLIER IN THIS CALL: ${parts.join('; ')}. Do not ask for these again.`.slice(0, MAX_CHARS);
}

/**
 * What to send the model immediately after the sliding window has discarded the
 * conversation.
 *
 * The "do not greet again" half is unconditional, and is the more important
 * half. What survives a compression is the system instruction — which ends
 * "Begin the call by greeting the caller, for example: ...". With no history
 * left to contradict it, the model follows it: it greets the caller a second
 * time and starts the call over, several minutes in. That is what a compression
 * sounds like from the other end of the phone, and it happens whether or not we
 * know anything about the caller yet — so it cannot be attached to the facts.
 */
export function restateAfterCompression(state: CallState): string {
  const facts = stateLine(state);
  return (
    'The call is already under way — you have greeted the caller and been talking for a while. ' +
    'Do NOT greet them again or restart the conversation; carry on from where you were.' +
    (facts ? ` ${facts}` : '')
  );
}
