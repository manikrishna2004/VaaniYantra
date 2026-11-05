// Supported languages and voices for agents.
// Voice IDs follow Google Cloud Text-to-Speech naming. When USE_MOCK_SPEECH is
// on, these are treated as opaque labels by the mock TTS.

export type LanguageOption = {
  code: string; // BCP-47, e.g. "hi-IN"
  label: string;
  nativeLabel: string;
  voices: VoiceOption[];
};

export type VoiceOption = {
  id: string; // Google TTS voice name
  label: string;
  gender: 'female' | 'male';
};

export const LANGUAGES: LanguageOption[] = [
  {
    code: 'en-IN',
    label: 'English (India)',
    nativeLabel: 'English',
    voices: [
      { id: 'en-IN-Neural2-A', label: 'Aanya', gender: 'female' },
      { id: 'en-IN-Neural2-B', label: 'Arjun', gender: 'male' },
      { id: 'en-IN-Standard-A', label: 'Riya (Standard)', gender: 'female' },
    ],
  },
  {
    code: 'hi-IN',
    label: 'Hindi',
    nativeLabel: 'हिन्दी',
    voices: [
      { id: 'hi-IN-Neural2-A', label: 'Saanvi', gender: 'female' },
      { id: 'hi-IN-Neural2-C', label: 'Vivaan', gender: 'male' },
      { id: 'hi-IN-Standard-A', label: 'Ananya (Standard)', gender: 'female' },
    ],
  },
  {
    code: 'te-IN',
    label: 'Telugu',
    nativeLabel: 'తెలుగు',
    voices: [
      { id: 'te-IN-Standard-A', label: 'Lakshmi', gender: 'female' },
      { id: 'te-IN-Standard-B', label: 'Ravi', gender: 'male' },
    ],
  },
  {
    code: 'ta-IN',
    label: 'Tamil',
    nativeLabel: 'தமிழ்',
    voices: [
      { id: 'ta-IN-Neural2-A', label: 'Kavya', gender: 'female' },
      { id: 'ta-IN-Neural2-B', label: 'Surya', gender: 'male' },
      { id: 'ta-IN-Standard-A', label: 'Meena (Standard)', gender: 'female' },
    ],
  },
  {
    code: 'ml-IN',
    label: 'Malayalam',
    nativeLabel: 'മലയാളം',
    voices: [
      { id: 'ml-IN-Standard-A', label: 'Devika', gender: 'female' },
      { id: 'ml-IN-Standard-B', label: 'Nikhil', gender: 'male' },
    ],
  },
  {
    code: 'kn-IN',
    label: 'Kannada',
    nativeLabel: 'ಕನ್ನಡ',
    voices: [
      { id: 'kn-IN-Standard-A', label: 'Ananya', gender: 'female' },
      { id: 'kn-IN-Standard-B', label: 'Karthik', gender: 'male' },
    ],
  },
  {
    code: 'mr-IN',
    label: 'Marathi',
    nativeLabel: 'मराठी',
    voices: [
      { id: 'mr-IN-Standard-A', label: 'Sneha', gender: 'female' },
      { id: 'mr-IN-Standard-B', label: 'Aarav', gender: 'male' },
    ],
  },
  {
    code: 'bn-IN',
    label: 'Bengali',
    nativeLabel: 'বাংলা',
    voices: [
      { id: 'bn-IN-Standard-A', label: 'Priya', gender: 'female' },
      { id: 'bn-IN-Standard-B', label: 'Rahul', gender: 'male' },
    ],
  },
  {
    code: 'gu-IN',
    label: 'Gujarati',
    nativeLabel: 'ગુજરાતી',
    voices: [
      { id: 'gu-IN-Standard-A', label: 'Diya', gender: 'female' },
      { id: 'gu-IN-Standard-B', label: 'Vivaan', gender: 'male' },
    ],
  },
  {
    code: 'pa-IN',
    label: 'Punjabi',
    nativeLabel: 'ਪੰਜਾਬੀ',
    voices: [
      { id: 'pa-IN-Standard-A', label: 'Simran', gender: 'female' },
      { id: 'pa-IN-Standard-B', label: 'Gurpreet', gender: 'male' },
    ],
  },

  // ── Global languages ────────────────────────────────────────────────────────
  // The realtime pipeline is Gemini Live, which speaks any of these natively;
  // the `language` code drives the accent (half-cascade) and the voice IDs below
  // are Google TTS voices used for the on-demand voice preview. Indian languages
  // above remain the defaults for India-based customers.
  {
    code: 'en-US',
    label: 'English (US)',
    nativeLabel: 'English (US)',
    voices: [
      { id: 'en-US-Neural2-F', label: 'Emma', gender: 'female' },
      { id: 'en-US-Neural2-D', label: 'Ethan', gender: 'male' },
    ],
  },
  {
    code: 'en-GB',
    label: 'English (UK)',
    nativeLabel: 'English (UK)',
    voices: [
      { id: 'en-GB-Neural2-A', label: 'Olivia', gender: 'female' },
      { id: 'en-GB-Neural2-B', label: 'Oliver', gender: 'male' },
    ],
  },
  {
    code: 'en-AU',
    label: 'English (Australia)',
    nativeLabel: 'English (AU)',
    voices: [
      { id: 'en-AU-Neural2-A', label: 'Chloe', gender: 'female' },
      { id: 'en-AU-Neural2-B', label: 'Jack', gender: 'male' },
    ],
  },
  {
    code: 'es-ES',
    label: 'Spanish (Spain)',
    nativeLabel: 'Español',
    voices: [
      { id: 'es-ES-Neural2-A', label: 'Lucía', gender: 'female' },
      { id: 'es-ES-Neural2-B', label: 'Mateo', gender: 'male' },
    ],
  },
  {
    code: 'es-US',
    label: 'Spanish (Latin America)',
    nativeLabel: 'Español (LatAm)',
    voices: [
      { id: 'es-US-Neural2-A', label: 'Sofía', gender: 'female' },
      { id: 'es-US-Neural2-B', label: 'Diego', gender: 'male' },
    ],
  },
  {
    code: 'fr-FR',
    label: 'French',
    nativeLabel: 'Français',
    voices: [
      { id: 'fr-FR-Neural2-A', label: 'Camille', gender: 'female' },
      { id: 'fr-FR-Neural2-B', label: 'Louis', gender: 'male' },
    ],
  },
  {
    code: 'de-DE',
    label: 'German',
    nativeLabel: 'Deutsch',
    voices: [
      { id: 'de-DE-Neural2-A', label: 'Mia', gender: 'female' },
      { id: 'de-DE-Neural2-B', label: 'Lukas', gender: 'male' },
    ],
  },
  {
    code: 'it-IT',
    label: 'Italian',
    nativeLabel: 'Italiano',
    voices: [
      { id: 'it-IT-Neural2-A', label: 'Giulia', gender: 'female' },
      { id: 'it-IT-Neural2-C', label: 'Marco', gender: 'male' },
    ],
  },
  {
    code: 'pt-BR',
    label: 'Portuguese (Brazil)',
    nativeLabel: 'Português',
    voices: [
      { id: 'pt-BR-Neural2-A', label: 'Ana', gender: 'female' },
      { id: 'pt-BR-Neural2-B', label: 'Pedro', gender: 'male' },
    ],
  },
  {
    code: 'ar-XA',
    label: 'Arabic',
    nativeLabel: 'العربية',
    voices: [
      { id: 'ar-XA-Standard-A', label: 'Layla', gender: 'female' },
      { id: 'ar-XA-Standard-B', label: 'Omar', gender: 'male' },
    ],
  },
  {
    code: 'cmn-CN',
    label: 'Chinese (Mandarin)',
    nativeLabel: '中文',
    voices: [
      { id: 'cmn-CN-Standard-A', label: 'Mei', gender: 'female' },
      { id: 'cmn-CN-Standard-B', label: 'Wei', gender: 'male' },
    ],
  },
  {
    code: 'ja-JP',
    label: 'Japanese',
    nativeLabel: '日本語',
    voices: [
      { id: 'ja-JP-Neural2-B', label: 'Yui', gender: 'female' },
      { id: 'ja-JP-Neural2-C', label: 'Haruto', gender: 'male' },
    ],
  },
  {
    code: 'ko-KR',
    label: 'Korean',
    nativeLabel: '한국어',
    voices: [
      { id: 'ko-KR-Neural2-A', label: 'Seoyeon', gender: 'female' },
      { id: 'ko-KR-Neural2-C', label: 'Minjun', gender: 'male' },
    ],
  },
  {
    code: 'ru-RU',
    label: 'Russian',
    nativeLabel: 'Русский',
    voices: [
      { id: 'ru-RU-Standard-A', label: 'Anna', gender: 'female' },
      { id: 'ru-RU-Standard-B', label: 'Ivan', gender: 'male' },
    ],
  },
  {
    code: 'tr-TR',
    label: 'Turkish',
    nativeLabel: 'Türkçe',
    voices: [
      { id: 'tr-TR-Standard-A', label: 'Elif', gender: 'female' },
      { id: 'tr-TR-Standard-B', label: 'Emir', gender: 'male' },
    ],
  },
  {
    code: 'id-ID',
    label: 'Indonesian',
    nativeLabel: 'Bahasa Indonesia',
    voices: [
      { id: 'id-ID-Standard-A', label: 'Putri', gender: 'female' },
      { id: 'id-ID-Standard-C', label: 'Budi', gender: 'male' },
    ],
  },
  {
    code: 'vi-VN',
    label: 'Vietnamese',
    nativeLabel: 'Tiếng Việt',
    voices: [
      { id: 'vi-VN-Standard-A', label: 'Linh', gender: 'female' },
      { id: 'vi-VN-Standard-B', label: 'Minh', gender: 'male' },
    ],
  },
  {
    code: 'pl-PL',
    label: 'Polish',
    nativeLabel: 'Polski',
    voices: [
      { id: 'pl-PL-Standard-A', label: 'Zofia', gender: 'female' },
      { id: 'pl-PL-Standard-B', label: 'Jakub', gender: 'male' },
    ],
  },
  {
    code: 'fil-PH',
    label: 'Filipino',
    nativeLabel: 'Filipino',
    voices: [
      { id: 'fil-PH-Standard-A', label: 'Maria', gender: 'female' },
      { id: 'fil-PH-Standard-C', label: 'Jose', gender: 'male' },
    ],
  },
];

// ── Gemini Live voices (the realtime pipeline's prebuilt voices) ─────────────
// These are REAL Gemini Live native-audio voices — the `id` is the exact voice
// name sent to the model (see src/lib/voice/live.ts). They are not dummies.
// We surface a friendly Indian display name + gender so customers can pick by
// persona; the agent's `geminiVoice` field still stores the underlying `id`.
// A demo clip can be synthesized on demand at /api/voices/preview?voice=<id>.
export type GeminiVoice = { id: string; label: string; gender: 'female' | 'male'; note: string };
export const GEMINI_VOICES: GeminiVoice[] = [
  { id: 'Aoede', label: 'Aanya', gender: 'female', note: 'Warm, friendly (default)' },
  { id: 'Kore', label: 'Diya', gender: 'female', note: 'Calm, clear' },
  { id: 'Puck', label: 'Arjun', gender: 'male', note: 'Upbeat, energetic' },
  { id: 'Charon', label: 'Rohan', gender: 'male', note: 'Deep, steady' },
  { id: 'Fenrir', label: 'Vikram', gender: 'male', note: 'Confident, bold' },
  { id: 'Leda', label: 'Riya', gender: 'female', note: 'Bright, youthful' },
  { id: 'Orus', label: 'Aditya', gender: 'male', note: 'Mature, professional' },
  { id: 'Zephyr', label: 'Saanvi', gender: 'female', note: 'Soft, soothing' },
  { id: 'Autonoe', label: 'Ananya', gender: 'female', note: 'Expressive, lively' },
  { id: 'Callirrhoe', label: 'Ishita', gender: 'female', note: 'Gentle, polished' },
  { id: 'Enceladus', label: 'Karan', gender: 'male', note: 'Relaxed, breathy' },
  { id: 'Iapetus', label: 'Nikhil', gender: 'male', note: 'Even, neutral' },
  { id: 'Umbriel', label: 'Dev', gender: 'male', note: 'Easygoing, casual' },
  { id: 'Algieba', label: 'Kabir', gender: 'male', note: 'Smooth, measured' },
  { id: 'Despina', label: 'Meera', gender: 'female', note: 'Light, articulate' },
  { id: 'Erinome', label: 'Kavya', gender: 'female', note: 'Crisp, precise' },
  { id: 'Algenib', label: 'Raghav', gender: 'male', note: 'Gravelly, grounded' },
  { id: 'Rasalgethi', label: 'Aryan', gender: 'male', note: 'Informative, clear' },
  { id: 'Schedar', label: 'Varun', gender: 'male', note: 'Balanced, reliable' },
  { id: 'Sulafat', label: 'Priya', gender: 'female', note: 'Warm, welcoming' },
];

export function isGeminiVoice(v: string | null | undefined): boolean {
  return Boolean(v) && GEMINI_VOICES.some((g) => g.id === v);
}

// ── Practice types (drives the prompt + booking defaults) ───────────────────
// VaaniYantra is a clinic and hospital platform: appointment booking, patient
// questions, and prescription follow-up. Each entry seeds the agent's prompt,
// greeting, and booking config.
//
// `retired: true` marks a business type we no longer sell but that existing
// agents may still carry. Retired entries keep their template so a live agent
// created under an older focus still renders and answers exactly as it did —
// they are simply filtered out of the picker (see SELECTABLE_AGENT_TYPES).
// Nothing here may be deleted outright: the value lives in Agent.agentType on
// real rows, and VERTICAL_TEMPLATES is what resolves it.
//
// ── The agency pivot ────────────────────────────────────────────────────────
//
// This list was narrowed to healthcare when the product was a clinic
// receptionist. It is now an agency serving several industries, so real estate,
// restaurants and education come back off the retired pile — they were hidden,
// never deleted, and their templates have been sitting here intact the whole
// time. Interior design and lead screening are new.
//
// `insurance`, `finance`, `ecommerce` and `salon` stay retired: still
// resolvable for any agent holding them, still not sold.
export const AGENT_TYPES = [
  { value: 'healthcare', label: 'Clinic / Polyclinic', hint: 'Books OPD appointments, answers timings, fees and location questions.' },
  { value: 'hospital', label: 'Hospital / Multi-speciality', hint: 'Routes by department, books consultations, answers admission questions.' },
  { value: 'dental', label: 'Dental Clinic', hint: 'Books check-ups and procedures, answers treatment and cost questions.' },
  { value: 'specialist', label: 'Specialist Practice', hint: 'Dermatology, orthopaedics, ENT, paediatrics — books consultations with the doctor.' },
  { value: 'diagnostics', label: 'Diagnostic Lab / Imaging', hint: 'Books tests and scans, answers preparation and report-timing questions.' },
  { value: 'other', label: 'Other healthcare provider', hint: 'A general patient appointment + information assistant.' },

  // ── Live verticals ────────────────────────────────────────────────────────
  { value: 'real_estate', label: 'Real Estate', hint: 'Books site visits, qualifies buyers, answers listing questions.' },
  { value: 'restaurant', label: 'Restaurant / Hospitality', hint: 'Takes reservations, answers menu, timing and location questions.' },
  { value: 'education', label: 'Education / Coaching', hint: 'Books counselling and demo classes, answers course and fee questions.' },
  { value: 'interior_design', label: 'Interior Design', hint: 'Books design consultations, captures scope, budget and timeline.' },
  // Horizontal rather than an industry: it qualifies inbound enquiries for any
  // business, so its prompt seed names no trade and leans on Agent.variables
  // for whatever the client actually sells.
  { value: 'lead_screening', label: 'Lead Screening (any business)', hint: 'Qualifies inbound enquiries against your criteria and routes the good ones.' },

  // ── Retired. Kept resolvable, hidden from the picker.
  { value: 'insurance', label: 'Insurance', hint: 'Books advisor calls, answers policy questions.', retired: true },
  { value: 'finance', label: 'Finance', hint: 'Books consultations, answers service questions.', retired: true },
  { value: 'ecommerce', label: 'E-commerce', hint: 'Answers order/product questions, books callbacks.', retired: true },
  { value: 'salon', label: 'Salon / Spa', hint: 'Books appointments, answers service questions.', retired: true },
] as const;

export type AgentVertical = (typeof AGENT_TYPES)[number]['value'];

// What the agent-setup picker offers. A retired type stays selected (and
// labelled) on an agent that already has it — the form adds it back for that
// one agent — but nobody can newly choose one.
export const SELECTABLE_AGENT_TYPES = AGENT_TYPES.filter((t) => !('retired' in t && t.retired));

// Retired types an allow-listed account may still pick, for building demo
// agents in industries we do not sell into. Gated per account by
// flags.demoVerticalsAllowed — a normal signed-in user never sees these.
//
// Empty since the agency pivot: real estate was the only entry, and it is a
// vertical we sell openly now, so the allow-list has nothing left to unlock.
// The mechanism stays because the next "demo for an industry we don't sell"
// request will want it, and rebuilding it costs more than keeping it.
export const DEMO_AGENT_TYPE_VALUES: readonly string[] = [];

// The picker's options for one account: the current practice types, plus the
// demo ones when that account is allow-listed.
export function selectableAgentTypesFor(demoVerticals: boolean) {
  if (!demoVerticals) return SELECTABLE_AGENT_TYPES;
  const demo = AGENT_TYPES.filter((t) =>
    (DEMO_AGENT_TYPE_VALUES as readonly string[]).includes(t.value),
  );
  return [...SELECTABLE_AGENT_TYPES, ...demo];
}

export function agentTypeLabel(value: string | null | undefined): string {
  return AGENT_TYPES.find((t) => t.value === value)?.label ?? 'Other';
}

// A field the agent should collect for this vertical's outcome, and the
// caller/owner message templates ({{key}} = a captured field, plus {{business}}
// and {{callerNumber}}). Seeds the agent's editable outcomeConfig.
export type OutcomeCapture = { key: string; label: string; required?: boolean };
export type OutcomePreset = {
  type: string; // lead | appointment | reservation | order | enquiry | callback
  captures: OutcomeCapture[];
  callerTemplate: string;
  ownerTemplate: string;
};

// Per-practice-type seeds for the guided agent setup: a starting greeting +
// prompt, booking defaults, and the outcome/notification preset. Users can edit
// everything after. Retired types keep their seeds so agents created under them
// keep behaving exactly as they were set up.
export const VERTICAL_TEMPLATES: Record<
  AgentVertical,
  {
    greeting: string;
    promptSeed: string;
    serviceName: string;
    serviceDurationMin: number;
    multiPerSlot: boolean;
    outcome: OutcomePreset;
  }
> = {
  interior_design: {
    greeting: 'Hello! Thanks for calling. Are you looking to start a project, or would you like to speak with a designer?',
    promptSeed:
      'You are the front desk of an interior design studio. Book design consultations and answer questions about the studio\u2019s style, process, past projects and typical timelines from your knowledge base. Find out what the caller wants done, the size of the space, and roughly when they want to start. Never quote a firm price or commit to a delivery date \u2014 scope drives both, so book a consultation for that.',
    serviceName: 'design consultation',
    serviceDurationMin: 45,
    multiPerSlot: false,
    outcome: {
      type: 'lead',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'scope', label: 'What they want designed', required: true },
        { key: 'propertyType', label: 'Property type / size' },
        { key: 'budget', label: 'Budget range' },
        { key: 'timeline', label: 'When they want to start' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for calling {{business}}. We\u2019ve noted your project ({{scope}}) and a designer will call you to arrange a consultation.',
      ownerTemplate:
        'New design enquiry \u2014 {{name}}, {{scope}} ({{propertyType}}). Budget: {{budget}}. Start: {{timeline}}. Callback: {{callerNumber}}.',
    },
  },
  // Horizontal. The prompt names no trade on purpose: what counts as a good
  // lead differs per client, so the qualifying criteria arrive through the
  // agent\u2019s knowledge base and {{variables}} rather than being baked in here.
  lead_screening: {
    greeting: 'Hi! Thanks for getting in touch. Can I ask a few quick questions so I can point you to the right person?',
    promptSeed:
      'You are a lead qualification agent for this business. Your job is to find out what the caller needs, decide whether it matches what the business actually does, and capture enough detail for the team to follow up well. Ask the qualifying questions in your knowledge base, one at a time, and keep it conversational \u2014 this is a screening call, not a form. If the caller is clearly not a fit, say so politely and do not take up more of their time. Never promise pricing, availability or a callback time you were not given.',
    serviceName: 'callback',
    serviceDurationMin: 15,
    multiPerSlot: false,
    outcome: {
      type: 'lead',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'need', label: 'What they are looking for', required: true },
        { key: 'company', label: 'Company / organisation' },
        { key: 'budget', label: 'Budget or size' },
        { key: 'timeline', label: 'Timeline' },
        { key: 'qualified', label: 'Fit for what we do' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for your interest in {{business}}. We\u2019ve captured your requirement ({{need}}) and the right person will be in touch.',
      ownerTemplate:
        'New qualified lead \u2014 {{name}}{{company}}: {{need}}. Budget: {{budget}}. Timeline: {{timeline}}. Fit: {{qualified}}. Callback: {{callerNumber}}.',
    },
  },
  real_estate: {
    greeting: 'Hello! Thanks for calling. Are you looking to view a property or have a question about a listing?',
    promptSeed:
      'You are a friendly real-estate front-desk agent. Help callers book property viewings and answer questions about listings, pricing, and availability from your knowledge base. Collect the caller’s name and the property they are interested in before booking.',
    serviceName: 'property viewing',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'lead',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'property', label: 'Property / area of interest', required: true },
        { key: 'budget', label: 'Budget' },
        { key: 'intent', label: 'Looking to buy or rent' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for your interest in {{property}}. We’ll share the details and our team will call you back shortly.',
      ownerTemplate: 'New lead — {{name}} is interested in {{property}} (budget: {{budget}}, {{intent}}). Callback: {{callerNumber}}.',
    },
  },
  insurance: {
    greeting: 'Hi! Thanks for calling. Would you like to speak with an advisor or ask about a policy?',
    promptSeed:
      'You are a helpful insurance front-desk agent. Book calls with advisors and answer general questions about policies and coverage from your knowledge base. Never quote exact premiums or give binding advice — book an advisor for that.',
    serviceName: 'advisor call',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'lead',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'interest', label: 'Policy interest', required: true },
        { key: 'preferredTime', label: 'Preferred callback time' },
      ],
      callerTemplate: 'Hi {{name}}, thanks for reaching out about {{interest}}. An advisor will call you at {{preferredTime}}.',
      ownerTemplate: 'New insurance lead — {{name}} wants {{interest}}. Preferred time: {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  healthcare: {
    greeting: 'Hello, thank you for calling. Would you like to book an appointment or ask a question?',
    promptSeed:
      'You are a warm, professional clinic receptionist. Book patient appointments and answer questions about consultation timings, doctors, fees, and location from your knowledge base. Never give medical advice, never interpret symptoms, and never suggest medicines — for anything clinical, book an appointment with the doctor. If a caller describes an emergency, tell them to go to the nearest emergency department or call an ambulance immediately.',
    serviceName: 'appointment',
    serviceDurationMin: 20,
    multiPerSlot: false,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Patient name', required: true },
        { key: 'reason', label: 'Reason for visit' },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for calling {{business}}. We’ve noted your request ({{reason}}) and will confirm your appointment shortly.',
      ownerTemplate: 'New appointment request — {{name}} ({{reason}}), preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  hospital: {
    greeting: 'Hello, thank you for calling. Which department can I help you with, or would you like to book a consultation?',
    promptSeed:
      'You are the front desk of a multi-speciality hospital. Find out which department or doctor the caller needs, book consultations, and answer questions about visiting hours, departments, admission and insurance from your knowledge base. Never give medical advice or interpret symptoms — beyond identifying the right department, book a consultation. If a caller describes an emergency, tell them immediately to come to the emergency department or call an ambulance, and do not continue with booking.',
    serviceName: 'consultation',
    serviceDurationMin: 20,
    multiPerSlot: false,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Patient name', required: true },
        { key: 'department', label: 'Department / speciality', required: true },
        { key: 'reason', label: 'Reason for visit' },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for calling {{business}}. We’ve noted your request for {{department}} and will confirm your consultation shortly.',
      ownerTemplate: 'New consultation request — {{name}} for {{department}} ({{reason}}), preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  dental: {
    greeting: 'Hi, thanks for calling! Would you like to book a dental appointment or ask about a treatment?',
    promptSeed:
      'You are a friendly dental clinic receptionist. Book check-ups, cleanings and treatment appointments, and answer questions about treatments, costs, timings and dentists from your knowledge base. Never give clinical advice or diagnose dental pain — book an appointment instead. If a caller is in severe pain or has had trauma to the mouth, offer the earliest available slot and tell them to call the clinic directly if nothing suits.',
    serviceName: 'dental appointment',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Patient name', required: true },
        { key: 'treatment', label: 'Treatment / reason', required: true },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for calling {{business}}. We’ve noted your {{treatment}} request and will confirm your appointment shortly.',
      ownerTemplate: 'New dental booking — {{name}} for {{treatment}}, preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  specialist: {
    greeting: 'Hello, thank you for calling. Would you like to book a consultation with the doctor?',
    promptSeed:
      'You are the receptionist for a specialist medical practice. Book consultations and follow-ups, and answer questions about the doctor’s timings, fees, location and what to bring from your knowledge base. Never give medical advice, interpret symptoms, or comment on test results — book a consultation for anything clinical. If a caller describes an emergency, tell them to go to the nearest emergency department immediately.',
    serviceName: 'consultation',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Patient name', required: true },
        { key: 'reason', label: 'Reason for visit' },
        { key: 'firstVisit', label: 'First visit or follow-up' },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for calling {{business}}. We’ve noted your request ({{reason}}) and will confirm your consultation shortly.',
      ownerTemplate: 'New consultation request — {{name}} ({{reason}}, {{firstVisit}}), preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  diagnostics: {
    greeting: 'Hello, thank you for calling. Would you like to book a test or scan, or ask about your report?',
    promptSeed:
      'You are the front desk of a diagnostic lab and imaging centre. Book tests and scans, and answer questions about preparation (such as fasting), timings, pricing and when reports are ready, from your knowledge base. Never interpret a test result or report, and never say whether a value is normal — for anything about what a result means, tell the caller to discuss it with their doctor.',
    serviceName: 'test appointment',
    serviceDurationMin: 15,
    multiPerSlot: true,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Patient name', required: true },
        { key: 'test', label: 'Test / scan requested', required: true },
        { key: 'referredBy', label: 'Referring doctor' },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate:
        'Hi {{name}}, thanks for calling {{business}}. We’ve noted your {{test}} booking and will confirm the slot shortly.',
      ownerTemplate: 'New test booking — {{name}} for {{test}} (referred by {{referredBy}}), preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  restaurant: {
    greeting: 'Hi, thanks for calling! Would you like to make a reservation or hear about our menu?',
    promptSeed:
      'You are a friendly restaurant host. Take table reservations and answer questions about the menu, timings, and location from your knowledge base. Ask for party size and name when booking.',
    serviceName: 'table reservation',
    serviceDurationMin: 90,
    multiPerSlot: true,
    outcome: {
      type: 'reservation',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'partySize', label: 'Party size', required: true },
        { key: 'time', label: 'Reservation time', required: true },
        { key: 'order', label: 'Pre-order / notes' },
      ],
      callerTemplate: 'Hi {{name}}, your table for {{partySize}} at {{business}} is noted for {{time}}. See you soon!',
      ownerTemplate: 'New reservation — {{name}}, party of {{partySize}} at {{time}}. Notes: {{order}}. Contact: {{callerNumber}}.',
    },
  },
  finance: {
    greeting: 'Hello! Thanks for calling. Would you like to book a consultation or ask about our services?',
    promptSeed:
      'You are a professional finance front-desk agent. Book consultations and answer general questions about services from your knowledge base. Do not give specific financial advice — book a consultation for that.',
    serviceName: 'consultation',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'lead',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'interest', label: 'Service of interest', required: true },
        { key: 'preferredTime', label: 'Preferred callback time' },
      ],
      callerTemplate: 'Hi {{name}}, thanks for your interest in {{interest}}. Our team will reach out at {{preferredTime}}.',
      ownerTemplate: 'New finance lead — {{name}} interested in {{interest}}. Preferred: {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  education: {
    greeting: 'Hi! Thanks for calling. Would you like to book a counselling session or ask about a course?',
    promptSeed:
      'You are a helpful education front-desk agent. Book counselling or demo sessions and answer questions about courses, fees, and schedules from your knowledge base.',
    serviceName: 'counselling session',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'lead',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'course', label: 'Course of interest', required: true },
        { key: 'preferredTime', label: 'Preferred callback time' },
      ],
      callerTemplate: 'Hi {{name}}, thanks for your interest in {{course}}. Our counsellor will call you at {{preferredTime}}.',
      ownerTemplate: 'New enquiry — {{name}} interested in {{course}}. Preferred: {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  ecommerce: {
    greeting: 'Hello! Thanks for calling. How can I help with your order or our products today?',
    promptSeed:
      'You are a helpful e-commerce support agent. Answer questions about orders, products, shipping, and returns from your knowledge base, and book a callback when a human follow-up is needed.',
    serviceName: 'callback',
    serviceDurationMin: 15,
    multiPerSlot: false,
    outcome: {
      type: 'callback',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'orderId', label: 'Order ID' },
        { key: 'issue', label: 'Question / issue', required: true },
      ],
      callerTemplate: 'Hi {{name}}, we’ve logged your query about {{issue}} and our team will follow up shortly.',
      ownerTemplate: 'New support request — {{name}} ({{issue}}), order {{orderId}}. Contact: {{callerNumber}}.',
    },
  },
  salon: {
    greeting: 'Hi, thanks for calling! Would you like to book an appointment or ask about our services?',
    promptSeed:
      'You are a friendly salon receptionist. Book appointments and answer questions about services, pricing, and stylists from your knowledge base. Ask which service and stylist the caller wants when booking.',
    serviceName: 'appointment',
    serviceDurationMin: 45,
    multiPerSlot: false,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Caller name', required: true },
        { key: 'service', label: 'Service', required: true },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate: 'Hi {{name}}, thanks for calling {{business}}. We’ve noted your {{service}} request and will confirm shortly.',
      ownerTemplate: 'New booking request — {{name}} wants {{service}}, preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
  other: {
    greeting: 'Hello! Thanks for calling. Would you like to book an appointment or ask a question?',
    promptSeed:
      'You are a warm, professional healthcare front-desk agent. Book patient appointments and answer questions about services, timings, fees and location from your knowledge base. Never give medical advice or interpret symptoms — book an appointment for anything clinical. If a caller describes an emergency, tell them to seek emergency care immediately.',
    serviceName: 'appointment',
    serviceDurationMin: 30,
    multiPerSlot: false,
    outcome: {
      type: 'appointment',
      captures: [
        { key: 'name', label: 'Patient name', required: true },
        { key: 'note', label: 'What they need', required: true },
        { key: 'preferredTime', label: 'Preferred time' },
      ],
      callerTemplate: 'Hi {{name}}, thanks for calling {{business}}. We’ve noted your request and will get back to you shortly.',
      ownerTemplate: 'New request — {{name}}: {{note}}, preferred {{preferredTime}}. Contact: {{callerNumber}}.',
    },
  },
};

// Public copy quotes a language count, and it has drifted from this catalogue
// before — a "25+ Indian languages" line shipped on the landing page while only
// ten Indian locales were ever configured. Derive the counts here so marketing
// text can never outrun LANGUAGES again.
export const INDIAN_LANGUAGES = LANGUAGES.filter((l) => l.code.endsWith('-IN'));
export const INDIAN_LANGUAGE_COUNT = INDIAN_LANGUAGES.length;

export function getLanguage(code: string): LanguageOption | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

export function getVoiceLabel(languageCode: string, voiceId: string): string {
  const lang = getLanguage(languageCode);
  return lang?.voices.find((v) => v.id === voiceId)?.label ?? voiceId;
}

export function defaultVoiceFor(languageCode: string): string {
  return getLanguage(languageCode)?.voices[0]?.id ?? 'en-IN-Neural2-A';
}

export const AGENT_DIRECTIONS = [
  { value: 'BOTH', label: 'Inbound & Outbound' },
  { value: 'INBOUND', label: 'Inbound only' },
  { value: 'OUTBOUND', label: 'Outbound only' },
] as const;

// ── Language mode ───────────────────────────────────────────────────────────
// How an agent decides which language to speak on a call.

export type LanguageMode = 'single' | 'hybrid' | 'auto' | 'multi';

export const LANGUAGE_MODES: { value: LanguageMode; label: string; hint: string }[] = [
  { value: 'single', label: 'Single language', hint: 'Always speak the selected language.' },
  {
    value: 'hybrid',
    label: 'Hybrid (English + local)',
    hint: 'Speak in a natural mix of English and the selected local language (e.g. Hinglish).',
  },
  {
    value: 'auto',
    label: 'Auto by caller location',
    hint: "Pick the language from the caller's phone number; falls back to the selected language.",
  },
  {
    value: 'multi',
    label: 'Multilingual (follow the caller)',
    hint: 'Open in the selected language, then switch to whichever supported language the caller speaks.',
  },
];

// ── Multilingual mode ───────────────────────────────────────────────────────
// The languages a 'multi' agent is allowed to switch into mid-call. Deliberately
// a SHORT list rather than all of LANGUAGES: the model holds these reliably in
// one instruction, and every code here must exist in LANGUAGES above (the
// instruction is built from their labels).
//
// 'multi' differs from 'auto' in where the language comes from. 'auto' resolves
// ONE language up front from the caller's number and the call is stuck with it —
// useless in India, where the number's calling code says nothing about what the
// caller actually speaks. 'multi' lets the model follow the caller turn by turn.
export const MULTILINGUAL_CODES = ['en-IN', 'hi-IN', 'mr-IN', 'te-IN', 'ta-IN', 'kn-IN'] as const;

// Build the extra system-prompt instruction for an agent's language mode.
// `language` is the configured BCP-47 code. We always name the target language
// AND demand a natural NATIVE Indian accent — without this the model tends to
// speak Indian languages with a foreign/English accent.
export function languageStyleInstruction(mode: LanguageMode | string, language: string): string {
  const lang = getLanguage(language);
  const name = (lang?.label ?? language).replace(' (India)', '');
  const native = lang?.nativeLabel ? ` (${lang.nativeLabel})` : '';
  if (mode === 'multi') {
    // Named languages, not "any Indian language": an open-ended instruction gets
    // the model improvising in languages there is no voice or transcription
    // quality for. The opening language is still the configured one, so the
    // greeting is predictable and the call has somewhere to fall back to.
    //
    // `named` is local to this branch so the wording of the other modes is
    // untouched. It drops the native label when it just repeats the English one
    // — only ever en-IN, where "English (English)" reads like a bug.
    const named = (code: string) => {
      const l = getLanguage(code);
      const n = (l?.label ?? code).replace(' (India)', '');
      return l?.nativeLabel && l.nativeLabel !== n ? `${n} (${l.nativeLabel})` : n;
    };
    const base = named(language);
    const others = MULTILINGUAL_CODES.filter((c) => c !== language).map(named);
    return (
      `\n\nLanguage: you are multilingual. Begin the call in ${base}, then speak whichever ` +
      `of these the caller uses: ${others.join(', ')}. Switch on the caller's FIRST reply — if they ` +
      `answer in one of those, continue the entire call in it, and keep speaking it unless they ` +
      `switch again. In whichever one you are speaking, MIX English into it the way bilingual speakers ` +
      `in India actually talk on the phone: everyday English words stay in English rather than being ` +
      `translated, and you never use the formal literary register nobody speaks on a phone. Match a ` +
      `caller who mixes the same way. Use a natural, NATIVE Indian accent and ` +
      `pronunciation in every one of them — sound like a local speaker, never a foreigner. Never ` +
      `announce that you are switching, never ask the caller which language they want, and never ` +
      `apologise for the language you were speaking. If they use a language that is not on that ` +
      `list, continue in ${base}. Numbers, names and the pincode are read back in the ` +
      `language you are currently speaking, but digits stay digits — never translate a pincode into words.`
    );
  }
  if (mode === 'hybrid') {
    return (
      `\n\nLanguage: speak in a natural, conversational mix of English and ${name}${native} — ` +
      `code-switch the way bilingual speakers in India actually talk on the phone. Use a natural, ` +
      `NATIVE Indian accent and pronunciation — sound like a local speaker, never a foreigner. Keep ` +
      `common English words in English; do not translate everything. Never announce that you are mixing languages.`
    );
  }
  // single / auto: one language, but the model still needs an explicit native-accent
  // instruction or it renders Indian languages with a foreign accent.
  return (
    `\n\nLanguage: speak entirely in ${name}${native}. Use a natural, NATIVE ${name} accent, ` +
    `pronunciation, and everyday colloquial phrasing — sound like a local native speaker from India, ` +
    `never like a foreigner speaking ${name}. Do not switch to other languages unless the caller does.`
  );
}

// ── Voice providers ─────────────────────────────────────────────────────────
// "google" is built into the platform; the rest are integrations that only work
// once the customer supplies the provider's API key (see env / Integrations).

export type VoiceProvider = 'google' | 'deepgram' | 'gemini' | 'elevenlabs';

export const VOICE_PROVIDERS: {
  value: VoiceProvider;
  label: string;
  builtIn: boolean;
  hint: string;
}[] = [
  { value: 'google', label: 'Google Cloud TTS', builtIn: true, hint: 'Built-in. All supported languages.' },
  { value: 'deepgram', label: 'Deepgram Aura', builtIn: false, hint: 'Integration. Low-latency English voices.' },
  { value: 'gemini', label: 'Gemini expressive', builtIn: false, hint: 'Integration. High quality, higher latency.' },
  { value: 'elevenlabs', label: 'ElevenLabs', builtIn: false, hint: 'Integration. Premium multilingual voices.' },
];

// ── Location → language (for auto language picking) ─────────────────────────
// Maps an E.164 calling-code prefix to a default language. Longest prefix wins,
// so country-specific entries override the broad ones. We only map to languages
// the platform actually supports; everything else falls back to the agent's
// configured language.
const COUNTRY_LANGUAGE: { prefix: string; language: string }[] = [
  { prefix: '+91', language: 'hi-IN' }, // India → Hindi (override per-agent if needed)
  { prefix: '+1', language: 'en-IN' }, // US/Canada → English
  { prefix: '+44', language: 'en-IN' }, // UK → English
  { prefix: '+61', language: 'en-IN' }, // Australia → English
  { prefix: '+971', language: 'en-IN' }, // UAE → English
  { prefix: '+65', language: 'en-IN' }, // Singapore → English
];

// Resolve the language to use for a call given the caller's number. Only returns
// a language the platform supports; otherwise returns the fallback unchanged.
export function languageForCaller(fromE164: string | undefined | null, fallback: string): string {
  if (!fromE164) return fallback;
  const normalized = fromE164.trim();
  // Longest matching dialing-code prefix wins.
  const match = [...COUNTRY_LANGUAGE]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((c) => normalized.startsWith(c.prefix));
  if (match && getLanguage(match.language)) return match.language;
  return fallback;
}

// A sensible starting prompt shown when creating a new agent.
export const DEFAULT_SYSTEM_PROMPT = `You are a friendly, professional voice assistant for a healthcare practice.

Guidelines:
- Keep replies short and natural — this is a phone call, not a chat.
- Speak one or two sentences at a time, then let the caller respond.
- If you don't know something, say so honestly and offer to follow up.
- Use the knowledge base provided to answer questions accurately.
- Be warm, patient, and clear — callers may be unwell or anxious.
- Never give medical advice, interpret symptoms, or suggest medicines. For
  anything clinical, book an appointment with the doctor.
- If a caller describes an emergency, tell them at once to go to the nearest
  emergency department or call an ambulance.`;

// ── Prescription vocabulary ──────────────────────────────────────────────────
//
// Indian prescriptions are written in Latin abbreviations that no patient
// reads: "BD" is twice a day, "HS" is at bedtime, "SOS" is only if needed.
// Each entry therefore carries three things:
//   • `label`  — what the doctor picks from, in the notation they already use
//   • `patient` — the plain sentence the chatbot and the patient portal show
//   • `abbr`  — the Latin abbreviation to echo alongside the plain words, or
//     null where the value is already an English word and echoing it would
//     produce "once a week (WEEKLY)". The data knows this; the formatter must
//     not have to guess from the string.
//   • `perDay` — how many doses a day, so "how many tablets today?" is a lookup
//     rather than the model doing arithmetic on prose. `null` where the answer
//     genuinely is not a number (SOS is as-needed; STAT is once, ever).
export const RX_FREQUENCIES = [
  { value: 'od', abbr: 'OD', label: 'OD — once a day', patient: 'once a day', perDay: 1 },
  { value: 'bd', abbr: 'BD', label: 'BD — twice a day', patient: 'twice a day', perDay: 2 },
  { value: 'tds', abbr: 'TDS', label: 'TDS — three times a day', patient: 'three times a day', perDay: 3 },
  { value: 'qid', abbr: 'QID', label: 'QID — four times a day', patient: 'four times a day', perDay: 4 },
  { value: 'hs', abbr: 'HS', label: 'HS — at bedtime', patient: 'at bedtime', perDay: 1 },
  { value: 'sos', abbr: 'SOS', label: 'SOS — only if needed', patient: 'only if needed', perDay: null },
  { value: 'stat', abbr: 'STAT', label: 'STAT — immediately, once', patient: 'immediately, one dose only', perDay: null },
  { value: 'weekly', abbr: null, label: 'Once a week', patient: 'once a week', perDay: null },
] as const;

export type RxFrequency = (typeof RX_FREQUENCIES)[number]['value'];

export function rxFrequency(value: string | null | undefined) {
  return RX_FREQUENCIES.find((f) => f.value === value) ?? null;
}

export const RX_ROUTES = [
  { value: 'oral', label: 'By mouth', patient: 'by mouth' },
  { value: 'topical', label: 'Applied to the skin', patient: 'applied to the skin' },
  { value: 'inhaled', label: 'Inhaled', patient: 'inhaled' },
  { value: 'drops_eye', label: 'Eye drops', patient: 'as eye drops' },
  { value: 'drops_ear', label: 'Ear drops', patient: 'as ear drops' },
  { value: 'nasal', label: 'Nasal spray/drops', patient: 'into the nose' },
  { value: 'injection', label: 'Injection', patient: 'as an injection' },
  { value: 'other', label: 'Other', patient: '' },
] as const;

export type RxRoute = (typeof RX_ROUTES)[number]['value'];

export function rxRoute(value: string | null | undefined) {
  return RX_ROUTES.find((r) => r.value === value) ?? null;
}
