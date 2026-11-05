/**
 * Ad #2 — the reschedule call. 86s, Smilecare Dental, same doctor as ad #1.
 *
 * A patient rings to cancel, changes her mind mid-sentence, asks to be moved to
 * a time that does not exist, is told no, and takes one that does. The beat the
 * ad is built around is 48.83: the agent refuses. Ad #1 sold "it found a slot
 * you never offered"; this one sells "it will not invent one".
 *
 * Windows are read off the real word onsets in reschedule-call.deepgram.json.
 * Text is verbatim — where recognition and speech disagree the speech wins, and
 * align-cues.mjs anchors what it can and interpolates the rest.
 */
export const json = 'sales/media/reschedule-call.deepgram.json';
export const flac = 'sales/media/reschedule-call.flac';
export const fallbackDuration = 86.02;
export const outroPhase = 'It kept up';

// Speech ends at 86.02 — on the last sample, mid-word: the source recording
// cuts "website" off at "web". Two seconds of silence are padded onto the m4a
// so the final caption has somewhere to land and the brand card is not slammed
// onto the last syllable. The card comes up here, in that silence.
export const outroAt = 86.60;

const A = 'ai', H = 'human';

// Two windows below override diarisation, the same way ad #1 does:
//
//   42.50/42.75  Deepgram gives "10AM" and "10:20" to the caller; they are the
//                agent still reading the list. She cuts in over the tail of it.
//                The windows overlap on purpose — a caller talking over the
//                agent is the realest second in the file, and smoothing it out
//                would be inventing a politeness the recording does not have.
//   23.90/23.91  One utterance carries both the reversal and the new request.
//                Split so "Cancel मत करना" lands on its own before the 28th is
//                named — the U-turn is the line, and it should not share.
export const turns = (DURATION) => [
  { t: 0.08,  end: 2.42,  who: A, phase: 'Connected', lang: true,
    line: 'Thank you, <em>Smilecare</em>. How can I help you today?' },

  { t: 3.68,  end: 8.82,  who: H, phase: 'Why they called',
    line: 'Hello. मेरा appointment था कल सुबह <em>राहुल मेहता</em> के साथ. I want to <em>cancel</em> it.',
    gloss: 'Hello. I had an appointment tomorrow morning with Rahul Mehta. I want to cancel it.' },

  // It does not ask her to repeat the booking back — it already has it.
  { t: 11.12, end: 16.57, who: A, phase: 'It has the booking already', panel: 'calendar', existing: true,
    line: 'Oh, ok. No problem. I see your appointment with <em>Dr. Rahul Mehta</em> for <em>tomorrow at 9 AM</em>.' },

  // And it does not act on "cancel" until she says so twice.
  { t: 16.80, end: 19.77, who: A, phase: 'It asks before it acts', panel: 'calendar', existing: true,
    line: 'Do you want to cancel it? I can do that for you.' },

  { t: 20.07, end: 23.90, who: H, phase: 'The U-turn', panel: 'calendar', existing: true,
    line: 'Appointment cancel करना है ना? नहीं नहीं ना. <em>Cancel मत करना.</em>',
    gloss: 'Cancel the appointment? No, no — don’t cancel it.' },

  { t: 23.91, end: 29.33, who: H, phase: 'Reschedule, not cancel', panel: 'calendar', existing: true,
    line: 'मुझे ना <em>28th</em> को reschedule करना, 28th <em>दो बजे</em>.',
    gloss: 'I want to reschedule to the 28th — the 28th, two o’clock.' },

  { t: 32.03, end: 42.50, who: A, phase: 'Reading the real day', panel: 'calendar', existing: true, slots: true, day28: true,
    line: 'Ok, you want to reschedule to the <em>28th</em>. Let me check. <em>Dr. Rahul Mehta</em> is available on <em>August 28</em> at 9AM, 9:20, 9:40, 10AM, 10:20.' },

  // She asks for a time that was never on the list, and asks twice.
  { t: 42.75, end: 47.01, who: H, phase: 'A time that isn’t there', panel: 'calendar', existing: true, slots: true, day28: true, want2pm: true,
    line: 'I want it <em>2PM</em>. Please schedule at <em>2PM</em>.' },

  { t: 48.83, end: 52.61, who: A, phase: 'It says no', panel: 'calendar', existing: true, slots: true, day28: true, want2pm: true,
    line: 'I’m sorry, <em>Dr. Rahul Mehta</em> is <em>not available at 2PM</em> on the 28th.' },

  { t: 52.97, end: 58.51, who: A, phase: 'And says what is true', panel: 'calendar', existing: true, slots: true, day28: true, want2pm: true,
    line: 'उस दिन उनके slots सुबह <em>दस चालीस</em> तक ही हैं. क्या आप कोई और time prefer करेंगे या कोई और दिन?',
    gloss: 'His slots that day only run to 10:40 in the morning. Would you prefer another time, or another day?' },

  { t: 59.37, end: 64.27, who: H, phase: 'She takes one that exists', panel: 'calendar', existing: true, slots: true, day28: true,
    line: 'दस चालीस… then <em>10:20</em> को book करना, <em>10:20AM</em> को.',
    gloss: 'Ten forty… then book 10:20 — 10:20 AM.' },

  // One row goes out as another goes green. This is the shot.
  { t: 67.94, end: 72.36, who: A, phase: 'Moved on the real calendar', panel: 'calendar', existing: true, slots: true, day28: true, book: true,
    line: 'Ok, perfect. Your appointment has been <em>rescheduled to August 28 at 10:20 AM</em>.' },

  { t: 73.14, end: 75.64, who: A, phase: 'Confirmation on WhatsApp', panel: 'sms',
    line: 'आपको <em>WhatsApp</em> message आ जाएगा details के साथ.',
    gloss: 'You’ll get a WhatsApp message with the details.' },

  { t: 75.94, end: 77.64, who: A, phase: 'Anything else?', panel: 'sms',
    line: 'Anything else I can help you with?' },

  { t: 78.19, end: 79.33, who: H, phase: 'Anything else?', panel: 'sms',
    line: 'No no, thank you.' },

  // The outro names the portal out loud, so the panel is earned this time.
  { t: 80.96, end: DURATION, who: A, phase: 'And afterwards', panel: 'portal',
    line: 'If you have any further questions, please feel free to call us back or visit the <em>chatbot on our clinic website</em>.' },
];
