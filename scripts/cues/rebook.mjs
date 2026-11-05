/**
 * Ad #3 — the cancel-and-rebook call. 125s, Smilecare Dental, Dr. Ananya Rao.
 *
 * Telugu and English, mixed mid-sentence. A patient cancels a booking she
 * cannot keep, asks for a day the clinic is CLOSED, is told no, and is then
 * given the doctor's actual hours and picks a time inside them.
 *
 * Two beats, and they are the ones the product just learned:
 *
 *   66.06  It refuses a day the clinic does not open. Ad #2 sold "it will not
 *          invent a slot"; this sells "it will not invent a day".
 *   83.39  It answers with the HOURS — "morning 9 AM to evening 6 PM, what time
 *          suits you?" — instead of reciting slot times at somebody on a
 *          telephone. Until the fix that shipped this morning it could only
 *          read back the first few slots of the day, every day.
 *
 * Windows are read off the real word onsets in rebook-call.deepgram.json
 * (Deepgram nova-2, language=multi — Telugu is not offered on its own, and the
 * Hindi model transcribed a third of the call as noise).
 *
 * TEXT IS THE PRODUCT'S OWN TRANSCRIPT, verbatim, pulled from TranscriptTurn
 * for call cmtdyg7hq002dnf7ehp6yqxge. That is the same rule ads #1 and #2
 * follow and it matters more here than in either: Deepgram renders "మీకు" as
 * "Miku" and "దొరుకుతుందండి" as "in Naru". What the clinic sees in its own
 * dashboard is what goes on screen.
 */
export const json = 'sales/media/rebook-call.deepgram.json';
export const flac = 'sales/media/rebook-call.flac';
export const fallbackDuration = 124.93;
export const outroPhase = 'It held the line';

// Speech ends at 124.93. Two seconds of silence are padded onto the m4a so the
// last caption has somewhere to land and the brand card is not slammed onto the
// final syllable. The card comes up here, in that silence.
export const outroAt = 125.40;

const A = 'ai', H = 'human';

export const turns = (DURATION) => [
  { t: 0.78, end: 3.60, who: A, phase: 'Connected', lang: true,
    line: 'Hello, thank you for calling <em>Smilecare Dental</em>. How can I help you today?' },

  { t: 4.24, end: 9.20, who: H, phase: 'Why they called',
    line: 'ఆ హలో, నాకు ఒక <em>అపాయింట్‌మెంట్</em> ఉంది. ఆ <em>సెప్టెంబర్ 2న</em> — అది <em>క్యాన్సిల్</em> చేయండి.',
    gloss: 'Hello, I have an appointment. On September 2nd — please cancel it.' },

  { t: 10.32, end: 15.60, who: A, phase: 'It asks for one thing',
    line: 'Oh, I understand. Cancel చేయడానికి మీ <em>ఫోన్ నెంబర్</em> చెప్పగలరా? నేను చెక్ చేస్తాను.',
    gloss: 'Oh, I understand. Could you give me your phone number to cancel it? I’ll check.' },

  // It reads the booking back before touching it.
  { t: 19.89, end: 23.90, who: A, phase: 'It already has the booking', panel: 'calendar', held: true,
    line: 'I found your appointment. <em>సెప్టెంబర్ 2nd, 11 AM</em> కి <em>Dr. అనన్య రావు</em>తో ఉంది, కదా?',
    gloss: 'I found your appointment. September 2nd, 11 AM with Dr. Ananya Rao — is that right?' },

  { t: 24.20, end: 26.40, who: A, phase: 'It asks before it acts', panel: 'calendar', held: true,
    line: 'అది <em>క్యాన్సిల్ చేయమంటారా?</em>',
    gloss: 'Would you like me to cancel it?' },

  { t: 26.61, end: 28.20, who: H, phase: 'It asks before it acts', panel: 'calendar', held: true,
    line: 'ఆహాహా, అది <em>క్యాన్సిల్ చేయండి</em>.',
    gloss: 'Yes, yes — cancel it.' },

  { t: 31.06, end: 36.44, who: A, phase: 'Off the real calendar', panel: 'calendar', held: true, cancelled: true,
    line: 'Okay, మీ అపాయింట్‌మెంట్ <em>క్యాన్సిల్ అయిపోయింది</em>. Do you have any other questions?',
    gloss: 'Okay, your appointment has been cancelled. Do you have any other questions?' },

  { t: 38.74, end: 45.20, who: H, phase: 'The real reason for the call', panel: 'calendar', cancelled: true,
    line: 'సెప్టెంబర్ 2న కుదరదు అందుకే క్యాన్సిల్ చేస్తున్నాం. ఆ <em>సెప్టెంబర్ 5న</em> బుక్ చేయగలరా?',
    gloss: 'The 2nd doesn’t work, that’s why we cancelled. Could you book September 5th?' },

  { t: 46.59, end: 53.20, who: A, phase: 'It takes the request', panel: 'calendar', cancelled: true,
    line: 'Sure, <em>సెప్టెంబర్ 5th</em> న బుక్ చేయొచ్చు. మీకు <em>డాక్టర్ అనన్య రావు</em>తోనే కావాలా?',
    gloss: 'Sure, September 5th can be booked. Do you want Dr. Ananya Rao specifically?' },

  { t: 54.76, end: 56.20, who: A, phase: 'It asks for the time', panel: 'calendar', cancelled: true,
    line: 'అండ్ ఏ <em>టైం</em> కి ప్రిఫర్ చేస్తారు?',
    gloss: 'And what time would you prefer?' },

  { t: 56.46, end: 62.80, who: H, phase: 'She names a day and a time', panel: 'calendar', cancelled: true, wantSept5: true,
    line: 'లేదు లేదు, <em>డాక్టర్ అనన్య రావు</em> తోనే చేయండి. ఆ రోజు మధ్యాహ్నం <em>3:00</em> చేయగలరా?',
    gloss: 'No, no — with Dr. Ananya Rao only. Can you do 3:00 in the afternoon that day?' },

  // THE BEAT. The 5th is not a busy day. It is a closed one, and it says so.
  { t: 64.62, end: 70.40, who: A, phase: 'It will not invent a day', panel: 'calendar', wantSept5: true, closed: true,
    line: 'Oh, I’m sorry. <em>సెప్టెంబర్ 5th</em> డాక్టర్ అనన్య రావు <em>క్లినిక్ క్లోజ్డ్</em> అండి.',
    gloss: 'Oh, I’m sorry. On September 5th Dr. Ananya Rao’s clinic is closed.' },

  { t: 70.60, end: 73.30, who: A, phase: 'And offers the way out', panel: 'calendar', wantSept5: true, closed: true,
    line: 'వేరే <em>డేట్</em> చూద్దామా, లేక వేరే <em>డాక్టర్</em> ని ప్రిఫర్ చేస్తారా? What do you say?',
    gloss: 'Shall we look at another date, or would you prefer another doctor? What do you say?' },

  { t: 74.51, end: 79.10, who: H, phase: 'She picks another day', panel: 'calendar', closed: true,
    line: 'అలా అయితే ఆ <em>సెప్టెంబర్ 3న</em> కుదురుతుందా చూడండి.',
    gloss: 'In that case, see whether September 3rd works.' },

  { t: 79.31, end: 83.20, who: A, phase: 'That one is open', panel: 'calendar', sept3: true,
    line: '<em>సెప్టెంబర్ 3rd</em> డాక్టర్ అనన్య రావు తో అపాయింట్‌మెంట్ <em>దొరుకుతుందండి</em>.',
    gloss: 'September 3rd with Dr. Ananya Rao is available.' },

  // THE SECOND BEAT. Not a list of twenty-minute slots — the hours, and a question.
  { t: 83.39, end: 88.90, who: A, phase: 'The hours, not a list', panel: 'calendar', sept3: true, hours: true,
    line: 'ఆ రోజు <em>మార్నింగ్ 9 AM</em> నుండి <em>ఈవినింగ్ 6 PM</em> వరకు అవైలబుల్. మీకు ఏ టైం <em>కంఫర్టబుల్</em>?',
    gloss: 'That day they’re available from 9 AM in the morning to 6 PM in the evening. What time suits you?' },

  { t: 90.11, end: 93.80, who: H, phase: 'She chooses', panel: 'calendar', sept3: true, hours: true,
    line: 'ఆ <em>3:00</em> కే చేయండి, ఆ రోజు కూడా.',
    gloss: 'Make it 3:00 — that day as well.' },

  { t: 94.03, end: 98.40, who: A, phase: 'The time she asked for', panel: 'calendar', sept3: true, hours: true, picked: true,
    line: 'Perfect. <em>సెప్టెంబర్ 3rd, 3 PM</em> కి డాక్టర్ అనన్య రావుతో అపాయింట్‌మెంట్ దొరుకుతుందండి.',
    gloss: 'Perfect. September 3rd at 3 PM with Dr. Ananya Rao is available.' },

  { t: 99.48, end: 101.30, who: A, phase: 'It asks before it acts', panel: 'calendar', sept3: true, hours: true, picked: true,
    line: 'బుక్ చేయమంటారా? <em>Shall I confirm the appointment?</em>',
    gloss: 'Shall I book it? Shall I confirm the appointment?' },

  { t: 101.73, end: 103.20, who: H, phase: 'It asks before it acts', panel: 'calendar', sept3: true, hours: true, picked: true,
    line: 'ఆహాహా, <em>చేసేయండి చేసేయండి</em>.',
    gloss: 'Yes, yes — go ahead, do it.' },

  { t: 105.90, end: 110.30, who: A, phase: 'Booked, and in writing', panel: 'sms',
    line: 'Wonderful, మీ అపాయింట్‌మెంట్ <em>కన్ఫర్మ్ అయిపోయింది</em>. మీకు <em>WhatsApp</em> లో డీటెయిల్స్ వస్తాయండి.',
    gloss: 'Wonderful, your appointment is confirmed. You’ll get the details on WhatsApp.' },

  { t: 110.45, end: 113.40, who: A, phase: 'Anything else?', panel: 'sms',
    line: 'Do you have any other questions I can help you with?' },

  { t: 113.78, end: 117.60, who: H, phase: 'Anything else?', panel: 'sms',
    line: 'లేదు లేదు. థాంక్యూ. <em>Thank you for the assistance.</em>',
    gloss: 'No, no. Thank you. Thank you for the assistance.' },

  { t: 117.98, end: DURATION, who: A, phase: 'And afterwards', panel: 'portal',
    line: 'You’re welcome. If you have any further questions, please feel free to call us back or visit the <em>chatbot on our clinic website</em>.' },
];
