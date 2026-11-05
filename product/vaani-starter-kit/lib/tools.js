/**
 * The things the agent can do, as opposed to say.
 *
 * Each tool is declared to the model in the shape Gemini expects, and handled
 * here. Two rules learned the hard way run through all of them:
 *
 *   1. A handler never throws. A rejected promise inside a live call leaves the
 *      model waiting forever and the caller listening to silence. Every failure
 *      comes back as a result the model can read out loud instead.
 *
 *   2. Every result carries a `say` field. Left to itself the model will read a
 *      raw ISO timestamp to a human being. Telling it what to say, in the
 *      result, is far more reliable than telling it in the prompt.
 */

import { openSlots, createEvent, calendarConfigured, spokenTime, todayISO } from '../connectors/calendar.js';
import { sendConfirmation } from '../connectors/whatsapp.js';
import { recordBooking, recordMessage } from '../connectors/store.js';

export function declarations() {
  const tools = [];

  if (calendarConfigured()) {
    tools.push({
      name: 'check_availability',
      description:
        'Look up free appointment times in the real diary. Call this before offering any time to the caller.',
      parameters: {
        type: 'OBJECT',
        properties: {
          date: {
            type: 'STRING',
            description:
              'The day to check, as YYYY-MM-DD. Work it out from today\'s date, which is in your instructions. ' +
              'Omit only if the caller truly has not indicated a day.',
          },
        },
      },
    });

    tools.push({
      name: 'book_appointment',
      description: 'Book a real appointment at a time that check_availability returned.',
      parameters: {
        type: 'OBJECT',
        properties: {
          startISO: {
            type: 'STRING',
            description: 'The exact startISO string returned by check_availability. Do not construct this yourself.',
          },
          name: { type: 'STRING', description: 'The caller\'s name, as they said it.' },
          reason: { type: 'STRING', description: 'Why they are coming in, in a few words. Optional.' },
        },
        required: ['startISO', 'name'],
      },
    });
  }

  tools.push({
    name: 'take_message',
    description:
      'Record a message for a human to act on. Use when you cannot answer or cannot book, before ending the call.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'The caller\'s name.' },
        note: { type: 'STRING', description: 'What they want, in one or two sentences.' },
        callbackNumber: { type: 'STRING', description: 'Best number to reach them, if they gave a different one.' },
      },
      required: ['note'],
    },
  });

  tools.push({
    name: 'end_call',
    description: 'Hang up. Call this after saying goodbye, once the call is finished.',
  });

  return tools;
}

/**
 * Run one tool call.
 *
 * `ctx` carries what the tool needs but the model should not choose: which call
 * this is, and what number the caller rang from. Letting the model supply the
 * destination number for a WhatsApp message would mean a misheard digit sends a
 * stranger someone else's appointment.
 */
export async function runTool(name, args = {}, ctx = {}) {
  try {
    switch (name) {
      case 'check_availability':
        return await checkAvailability(args);
      case 'book_appointment':
        return await bookAppointment(args, ctx);
      case 'take_message':
        return takeMessage(args, ctx);
      case 'end_call':
        return { ending: true };
      default:
        return { error: 'unknown tool', say: 'Sorry, I could not do that just now.' };
    }
  } catch (err) {
    // The caller is on the line. Log the real reason for us, hand the model
    // something human to say.
    console.error('[tools] ' + name + ' failed:', err.message);
    return {
      error: err.message,
      say: 'I am having trouble with the diary at the moment. Let me take your details and have someone call you back.',
    };
  }
}

async function checkAvailability({ date }) {
  const day = date || todayISO();
  const slots = await openSlots(day);

  if (!slots.length) {
    return {
      date: day,
      slots: [],
      say: 'Nothing is free that day. Offer to check a different day — do not read out times from another date.',
    };
  }

  const tz = process.env.BUSINESS_TIMEZONE || 'UTC';
  return {
    date: day,
    hours: spokenTime(new Date(slots[0].startISO).getTime(), tz) + ' to ' +
      spokenTime(new Date(slots[slots.length - 1].endISO).getTime(), tz),
    slots: slots.map((s) => ({ startISO: s.startISO, time: s.label })),
    say:
      'Offer at most two of these times, said naturally, for example "two thirty". ' +
      'If the caller has not named a time yet, tell them the hours instead and ask what suits them.',
  };
}

async function bookAppointment({ startISO, name, reason }, ctx) {
  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) {
    return {
      booked: false,
      say: 'Something went wrong with that time. Check the diary again and offer a time from it.',
    };
  }

  const slotMins = Number(process.env.SLOT_MINUTES || 30);
  const endISO = new Date(start.getTime() + slotMins * 60000).toISOString();

  // Re-check rather than trust the model's memory of an earlier lookup: a
  // minute of conversation is long enough for a slot to be taken elsewhere.
  const stillOpen = (await openSlots(startISO.slice(0, 10))).some((s) => s.startISO === startISO);
  if (!stillOpen) {
    return {
      booked: false,
      say: 'That time has just gone. Apologise briefly, check the diary again and offer another.',
    };
  }

  const event = await createEvent({
    startISO,
    endISO,
    summary: (name || 'Caller') + ' — ' + (reason || 'appointment'),
    description:
      'Booked by ' + (process.env.AGENT_NAME || 'the phone agent') +
      '\nCaller number: ' + (ctx.from || 'unknown') +
      (reason ? '\nReason: ' + reason : ''),
  });

  const when = spokenDateTime(start);
  const booking = { eventId: event.id, startISO, name, reason: reason || null, when };
  if (ctx.callSid) recordBooking(ctx.callSid, booking);

  // Fire the confirmation without blocking the call. The caller should hear
  // "that's booked" immediately, not after a round trip to Meta.
  if (ctx.from) {
    sendConfirmation({ to: ctx.from, name, when }).catch((err) =>
      console.error('[tools] confirmation failed:', err.message),
    );
  }

  return {
    booked: true,
    when,
    say: 'Confirm to the caller that they are booked for ' + when + ', said naturally.',
  };
}

function takeMessage({ name, note, callbackNumber }, ctx) {
  const message = {
    name: name || null,
    note,
    callbackNumber: callbackNumber || ctx.from || null,
    at: new Date().toISOString(),
  };
  if (ctx.callSid) recordMessage(ctx.callSid, message);
  console.log('[message]', JSON.stringify(message));
  return {
    saved: true,
    say: 'Tell the caller you have passed it on and someone will get back to them.',
  };
}

/** "Thursday the 1st of October at 2:30 PM" — a date a person can hear. */
function spokenDateTime(date) {
  const tz = process.env.BUSINESS_TIMEZONE || 'UTC';
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(date);
  return day + ' at ' + spokenTime(date.getTime(), tz);
}
