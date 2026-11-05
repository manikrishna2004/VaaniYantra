/**
 * Ad #1 — the toothache call. 88s, Smilecare Dental.
 *
 * Lifted verbatim out of scripts/align-cues.mjs when a second ad arrived and the
 * alignment machinery had to serve more than one recording. The machinery is in
 * align-cues.mjs; what is per-call — which file, and what was actually said — is
 * here. See scripts/cues/reschedule.mjs for the second call.
 */
export const json = 'sales/media/demo-call.deepgram.json';
export const flac = 'sales/media/demo-call.flac';
export const fallbackDuration = 88.06;

// ── The turns, verbatim, with windows read off the word timings ─────────────
// Two windows are sub-utterance splits diarisation got wrong: the caller's
// "मुझे ना…" is buried inside an agent utterance (its first word lands at
// 41.45), and one agent utterance holds three separate turns (63.59, 65.59).
const A = 'ai', H = 'human';
export const turns = (DURATION) => [
  { t: 0.48,  end: 5.14,  who: A, phase: 'Connected', lang: true,
    line: 'Hello, thank you for calling <em>Smilecare Dental</em>, how can I help you today? आप कैसे हैं?' },
  { t: 5.76,  end: 6.74,  who: H, phase: 'Connected',
    line: 'मैम, बहुत बढ़िया।', gloss: 'Ma’am, very good.' },
  { t: 7.60,  end: 11.46, who: H, phase: 'Why they called',
    line: 'आज ना मुझे दांत में दर्द हो रहा है। डॉक्टर से मिलना चाहता हूं।',
    gloss: 'I have a toothache today. I want to see a doctor.' },
  { t: 13.61, end: 24.18, who: A, phase: 'Offering a doctor',
    line: 'Oh, sorry to hear that. आपको दांत में दर्द हो रहा है? कोई बात नहीं, हम अपॉइंटमेंट बुक कर देते हैं. आप किस डॉक्टर के साथ अपॉइंटमेंट बुक करना चाहते हैं? <em>Dr. Aditi Sharma</em> या <em>Dr. Rahul Mehta</em>? कोई प्रेफरेंस है आपकी?',
    gloss: 'Sorry to hear that. You have a toothache? No problem, we’ll book an appointment. Which doctor would you like — Dr. Aditi Sharma or Dr. Rahul Mehta? Any preference?' },
  { t: 24.56, end: 28.59, who: H, phase: 'Caller asks for advice',
    line: 'मुझे पता नहीं, आप बता दीजिए कौन सी डॉक्टर अच्छा रहेगा मेरा दांत दर्द के लिए?',
    gloss: 'I don’t know — you tell me which doctor would be good for my toothache.' },
  { t: 31.33, end: 41.01, who: A, phase: 'Reading real slots', panel: 'calendar', slots: true,
    line: 'दांत दर्द के लिए <em>Dr. Rahul Mehta</em> बहुत अच्छे हैं, वो <em>Endodontist</em> हैं. क्या मैं आपके लिए कल सुबह <em>9:20</em> का टाइम बुक कर दूँ? या कोई और टाइम चाहिए? कल सुबह <em>9:40</em> या <em>10:00</em> बजे का भी टाइम available है. बताइए?',
    gloss: 'For toothache Dr. Rahul Mehta is very good — he’s an endodontist. Shall I book 9:20 tomorrow morning? Or another time? 9:40 or 10:00 are also available.' },
  // The moment worth keeping: a time that was never offered.
  { t: 41.45, end: 44.49, who: H, phase: 'Caller wants another time', panel: 'calendar', slots: true,
    line: 'नहीं नहीं… मुझे ना, मैं <em>11:00</em> आऊंगा, उस समय में स्लॉट है क्या?',
    gloss: 'No, no… I’ll come at 11:00 — is there a slot then?' },
  { t: 46.81, end: 53.07, who: A, phase: 'It checks, then asks', panel: 'calendar', slots: true, slot11: true,
    line: 'जी हाँ, बिल्कुल! कल सुबह <em>11:00</em> बजे का टाइम अवेलेबल है. क्या मैं यह बुक कर दूँ? और आपका <em>पूरा नाम</em> क्या है?',
    gloss: 'Yes, absolutely — 11:00 tomorrow morning is available. Shall I book it? And what is your full name?' },
  { t: 53.70, end: 60.83, who: H, phase: 'It checks, then asks', panel: 'calendar', slots: true, slot11: true,
    line: 'मेरा नाम <em>रमना</em> है। 11:00 बुक करना प्लीज।',
    gloss: 'My name is Ramana. Please book 11:00.' },
  { t: 60.87, end: 63.45, who: A, phase: 'Written to the calendar', panel: 'calendar', slots: true, slot11: true, book: true,
    line: 'ठीक है <em>रमना जी</em>, आपका अपॉइंटमेंट बुक हो गया है.',
    gloss: 'All right Ramana — your appointment is booked.' },
  { t: 63.59, end: 65.30, who: A, phase: 'Confirmation on WhatsApp', panel: 'sms',
    line: 'आपको <em>WhatsApp</em> पर डिटेल्स मिल जाएँगी.',
    gloss: 'You’ll get the details on WhatsApp.' },
  { t: 65.59, end: 66.90, who: A, phase: 'Anything else?', panel: 'sms',
    line: 'क्या आपके कोई और सवाल हैं?', gloss: 'Do you have any other questions?' },
  { t: 67.75, end: 70.17, who: H, phase: 'It answers, too', panel: 'sms',
    line: 'कंसल्टेशन फी कितना होगा?', gloss: 'How much is the consultation fee?' },
  { t: 72.49, end: 78.27, who: A, phase: 'It answers, too', panel: 'sms',
    line: 'Dr. Rahul Mehta की कंसल्टेशन फी <em>₹800</em> है. क्या आप कुछ और जानना चाहते हैं?',
    gloss: 'Dr. Rahul Mehta’s consultation fee is ₹800. Would you like to know anything else?' },
  { t: 78.66, end: 80.75, who: H, phase: 'It answers, too', panel: 'sms',
    line: 'नहीं-नहीं। ठीक है। हां। ठीक है। कल मैं <em>11:00</em> आऊंगा।',
    gloss: 'No, no. All right. Yes. All right. I’ll come at 11:00 tomorrow.' },
  { t: 83.53, end: DURATION, who: A, phase: 'And afterwards', panel: 'portal',
    line: 'ठीक है, थैंक यू फॉर कॉलिंग <em>Smilecare Dental</em>. अगर आपको कुछ और पूछना हो, तो बेझिझक कॉल कीजिएगा. बाय!',
    gloss: 'All right — thank you for calling Smilecare Dental. If you need anything else, do call. Bye!' },
];
