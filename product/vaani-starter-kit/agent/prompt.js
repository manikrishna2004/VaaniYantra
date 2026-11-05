/**
 * Builds the system instruction the model receives at the start of every call.
 *
 * The persona lives in prompt.md, which you edit. The clauses below are the
 * parts that cannot live in a static file because they depend on what is true
 * at the moment the phone rings — today's date, whether a calendar is
 * connected, whether WhatsApp is on.
 *
 * Order matters. Persona first, then facts, then rules, then the greeting last
 * so it is the freshest thing in the model's context when it starts talking.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calendarConfigured, nowInZone, todayISO } from '../connectors/calendar.js';
import { whatsappConfigured } from '../connectors/whatsapp.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The editable half, with {{VARS}} substituted and the notes-to-self stripped. */
export function persona() {
  const raw = readFileSync(join(here, 'prompt.md'), 'utf8');

  // Everything above the first '---' on its own line is documentation for the
  // human, not instruction for the model.
  const split = raw.split(/^---\s*$/m);
  const body = (split.length > 1 ? split.slice(1).join('---') : raw).trim();

  return body.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const value = process.env[key];
    if (value === undefined || value === '') {
      console.warn('[prompt] ' + whole + ' is not set — fill it in at /setup. Left as-is for now.');
      return whole;
    }
    return value;
  });
}

/**
 * The model has no clock. Without being told the date it cannot turn "next
 * Monday" into a date to look up, and it will not ask — it will just guess.
 */
function todayClause() {
  const tz = process.env.BUSINESS_TIMEZONE || 'UTC';
  return (
    '\n\n## Today\n\n' +
    'It is currently ' + nowInZone(tz) + ' (' + tz + '). Today is ' + todayISO(tz) + '. ' +
    'Work out every date the caller mentions from this. Never ask the caller what day it is.'
  );
}

/**
 * Booking rules. Only included when a calendar is connected — an agent told it
 * can book, that then cannot, is worse than one that never offered.
 */
function bookingClause() {
  if (!calendarConfigured()) {
    return (
      '\n\n## Appointments\n\n' +
      'You cannot see the diary on this line, so you cannot confirm a time yourself. ' +
      'If the caller wants an appointment, take their name, their number and roughly when suits them, ' +
      'then tell them someone will ring back to confirm. Do not promise a specific time.'
    );
  }

  return (
    '\n\n## Appointments\n\n' +
    'You can see the real diary and make real bookings.\n\n' +
    'To offer a time, first call check_availability. Pass the date whenever the caller names a day. ' +
    'Offer only times it gives back. Never offer a time it did not return, even if it sounds reasonable — ' +
    'the diary is the only thing that knows what is free.\n\n' +
    'If the caller has not said when they want to come, do not read out a list of times. ' +
    'Tell them roughly when you are open that day and ask what suits them. Read out specific times only ' +
    'when they say they have no preference, and then offer two, not ten.\n\n' +
    'If check_availability returns nothing for that day, say that day is full and offer to check another. ' +
    'Never quietly read out times from a different day.\n\n' +
    'Once they choose, call book_appointment with the exact startISO that check_availability gave you, ' +
    "plus the caller's name. Then confirm it back to them out loud."
  );
}

/** What the caller will and will not receive afterwards. */
function messagingClause() {
  if (!whatsappConfigured()) {
    return (
      '\n\n## Follow-up\n\n' +
      'Nothing is sent to the caller automatically on this line. Never promise a text, ' +
      'a WhatsApp message or an email — if they need something in writing, say someone will send it.'
    );
  }
  return (
    '\n\n## Follow-up\n\n' +
    'After a booking, a WhatsApp confirmation is sent to the number the caller rang from, automatically. ' +
    'Tell them to expect it there. Never offer to email them — there is no email on this line.'
  );
}

function recordingClause() {
  if (String(process.env.RECORDING_DISCLOSURE).toLowerCase() !== 'true') return '';
  return (
    '\n\n## Recording\n\n' +
    'In your very first sentence, before anything else, tell the caller this call may be recorded ' +
    'for quality and training. Say it once, briefly, then greet them normally.'
  );
}

/**
 * What to do when the caller wants a person.
 *
 * The kit cannot transfer a live call, so the agent must not offer to. Saying
 * "putting you through" and then not doing it is worse than never offering:
 * the caller waits on a line that is going nowhere. Taking a message and
 * promising a callback is a promise the kit can actually keep.
 */
function askingForAPersonClause() {
  return (
    '\n\n## Asking for a person\n\n' +
    'If the caller asks to speak to a human, or is upset, do not argue and do not try to handle it yourself. ' +
    'You cannot put them through from this line, so never say you will transfer them, connect them, or ' +
    'pass them over. Say you will get someone to call them straight back, take their name and number ' +
    'with take_message, and end the call politely.'
  );
}

function endCallClause() {
  return (
    '\n\n## Hanging up\n\n' +
    'When the call is done and you have said goodbye, call end_call to hang up. ' +
    'Do not sit in silence waiting for the caller to go first.'
  );
}

/** The opening line. Last, so it is freshest when the model starts speaking. */
function greetingClause() {
  const greeting =
    process.env.AGENT_GREETING ||
    'Thanks for calling ' + (process.env.BUSINESS_NAME || 'us') + ', this is ' +
      (process.env.AGENT_NAME || 'reception') + ' — how can I help?';
  return '\n\nBegin the call by greeting the caller, for example: "' + greeting + '"';
}

export function buildSystemInstruction() {
  return (
    persona() +
    todayClause() +
    bookingClause() +
    messagingClause() +
    recordingClause() +
    askingForAPersonClause() +
    endCallClause() +
    greetingClause()
  );
}
