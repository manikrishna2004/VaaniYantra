import type { AgentVertical } from '@/lib/constants';

// ── The six industries we sell into, as marketing content ───────────────────
//
// One table, six pages. `/solutions/[vertical]` renders whichever row matches
// the slug, so adding a seventh industry is an entry here — not a new page, not
// a new component, and not another hand-built layout to keep in sync. That is
// the whole reason `for-dental-clinics/` and `ai-receptionist-for-clinics/`
// were folded into this: two bespoke pages had already started to drift apart
// in copy, CTA wording and structure.
//
// ⚠ NO INVENTED SOCIAL PROOF, same rule as the landing page. There are no
// customer counts, no logos and no "N clinics trust us" anywhere in this file,
// because none of it is true yet. Where a number would genuinely help, it is a
// bracketed placeholder the founder fills in — a fabricated statistic on a page
// a buyer forwards to their boss is worse than no statistic at all.
//
// `slug` is the URL and is permanent once shipped: it is what search engines
// and inbound links hold. `agentType` ties the page to the agent template in
// src/lib/constants.ts, so the page and the thing it sells cannot drift.

export type VerticalAccent = {
  /** For the app's light surfaces. >= 4.5:1 on white. */
  light: string;
  /** For the marketing ground. >= 4.5:1 on bg-inverse (#0a0e17). */
  dark: string;
  /** Readable ink for text sitting ON the accent. */
  on: string;
  /** Low-alpha wash for icon tiles and halos. */
  soft: string;
};

export type Solution = {
  slug: string;
  /** The matching agent template. Keeps the page honest about what it sells. */
  agentType: AgentVertical;
  /** Short label, for nav and chips. */
  name: string;
  /** <title> and H1 support. */
  title: string;
  metaDescription: string;
  /** The H1, split so the second half can take the accent colour. */
  headline: { lead: string; accented: string };
  /** One paragraph under the H1. States the problem, not the feature list. */
  lede: string;
  /** The card blurb on the landing page's industry grid. */
  cardBlurb: string;
  /** What a build for this industry contains — shown on the landing card. */
  cardMeta: string;
  accent: VerticalAccent;
  /** What the agent captures on every call. Mirrors the outcome preset. */
  captures: { label: string; note: string }[];
  /** Six capabilities, written for this trade rather than for software buyers. */
  features: { title: string; desc: string }[];
  /** The closing ask. Specific to what this buyer can easily hand over. */
  cta: { headline: string; sub: string };
};

export const SOLUTIONS: Solution[] = [
  {
    slug: 'healthcare',
    agentType: 'healthcare',
    name: 'Healthcare',
    title: 'AI receptionist for clinics and hospitals',
    metaDescription:
      'An AI receptionist that answers every patient call, books on the right consultant’s calendar and never gives medical advice. Twelve languages, your systems unchanged.',
    headline: { lead: 'Every patient call answered.', accented: 'Every appointment on the right calendar.' },
    lede:
      'A patient who cannot get through does not leave a voicemail — they ring the clinic down the road. Our agent picks up on the first ring, answers from what you gave it, and books a confirmed slot with the right consultant.',
    cardBlurb:
      'Clinics, hospitals and labs. Books on the right consultant’s calendar, routes by department, and never gives medical advice.',
    cardMeta: 'Voice · booking · records',
    accent: { light: '#0c6f6a', dark: '#3fbfb8', on: '#04211f', soft: 'rgba(63,191,184,0.14)' },
    captures: [
      { label: 'Patient name and callback number', note: 'always' },
      { label: 'Reason for the visit', note: 'always' },
      { label: 'Department or consultant', note: 'routed live' },
      { label: 'Preferred time', note: 'checked against the calendar' },
      { label: 'Appointment slot', note: 'confirmed in-call' },
    ],
    features: [
      {
        title: 'Books on the right consultant’s calendar',
        desc: 'Every doctor connects their own Google Calendar. The agent reads that consultant’s real availability mid-call, books a confirmed slot, and texts the patient before they hang up.',
      },
      {
        title: 'Routes by department',
        desc: 'Cardiology, orthopaedics, radiology, billing. The caller says why they are ringing and lands in the right place — or gets booked without being transferred at all.',
      },
      {
        title: 'Never gives medical advice',
        desc: 'It does not interpret symptoms and does not suggest medicines. Anything clinical becomes an appointment with the doctor, which is the only safe answer a front desk can give.',
      },
      {
        title: 'Emergencies are caught before the model runs',
        desc: 'A deterministic check sits in front of the conversation. A caller describing an emergency is told to go to the emergency department or call an ambulance, immediately, and booking stops.',
      },
      {
        title: 'Your HIS stays the source of truth',
        desc: 'Push patients and prescriptions to us, or let us read them live. Your system keeps its authority — we never become a second record you have to reconcile.',
      },
      {
        title: 'Answers only from what you gave it',
        desc: 'Timings, departments, consultants, fees, preparation instructions. It answers from those, and says honestly when a question falls outside them.',
      },
    ],
    cta: {
      headline: 'Bring us a week of missed calls',
      sub: 'We will tell you how many were patients trying to book, and what it would take to answer all of them.',
    },
  },
  {
    slug: 'real-estate',
    agentType: 'real_estate',
    name: 'Real estate',
    title: 'AI call answering for real estate and brokerages',
    metaDescription:
      'An AI agent that answers every property enquiry on the first ring, qualifies on budget and intent, and books site visits into your negotiator’s calendar.',
    headline: { lead: 'Every enquiry answered.', accented: 'Every site visit actually booked.' },
    lede:
      'Portal leads go cold fast — call back late and they have already spoken to the next listing. Our agent picks up on the first ring, qualifies on budget and intent, and puts a confirmed slot in your negotiator’s calendar.',
    cardBlurb:
      'Site visits booked mid-call, buyers qualified on budget and intent before anyone drives out to a viewing.',
    cardMeta: 'Voice · site visits · CRM',
    accent: { light: '#1d5fb8', dark: '#6fa8ff', on: '#06121f', soft: 'rgba(111,168,255,0.14)' },
    captures: [
      { label: 'Name and callback number', note: 'always' },
      { label: 'Property or area of interest', note: 'always' },
      { label: 'Buy or rent', note: 'always' },
      { label: 'Budget band', note: 'flagged if below list' },
      { label: 'Site visit slot', note: 'confirmed in-call' },
    ],
    features: [
      {
        title: 'Answers on the first ring, however many call',
        desc: 'A launch weekend becomes simultaneous conversations rather than a queue and a voicemail box nobody clears on Monday.',
      },
      {
        title: 'Speaks the way your buyers speak',
        desc: 'Twelve languages, code-switching mid-sentence — Hinglish, Tanglish, Tenglish — because that is how the call actually goes.',
      },
      {
        title: 'Books into the right negotiator’s calendar',
        desc: 'Each agent connects their own calendar. The slot is confirmed live on the call and the buyer gets a message before they hang up.',
      },
      {
        title: 'Qualifies before it books',
        desc: 'Budget, intent and timeline captured first, so nobody drives across town for a viewing that was never going to close.',
      },
      {
        title: 'Answers only from your listings',
        desc: 'Prices, sizes, floors, possession dates, amenities — from the sheet you gave it. It says it does not know rather than inventing.',
      },
      {
        title: 'Lands in the CRM you already use',
        desc: 'The lead, the recording, the summary and the captured fields, pushed the moment the call ends. No second system to reconcile.',
      },
    ],
    cta: {
      headline: 'Bring us a week of missed calls',
      sub: 'We will tell you how many were real buyers, and what it would take to answer all of them.',
    },
  },
  {
    slug: 'restaurants',
    agentType: 'restaurant',
    name: 'Restaurants & hospitality',
    title: 'AI phone answering for restaurants and hospitality',
    metaDescription:
      'An AI agent that takes reservations, answers menu and timing questions, and handles the 7pm rush without anyone leaving the floor.',
    headline: { lead: 'Nobody leaves the floor', accented: 'to answer the phone.' },
    lede:
      'The phone rings hardest exactly when the room is fullest, and every call taken is a table not being served. Our agent takes the booking, answers the question, and lets your staff stay with the guests in front of them.',
    cardBlurb:
      'Reservations, covers and timings answered on the first ring — including the rush that all lands at 7pm on a Friday.',
    cardMeta: 'Voice · reservations',
    accent: { light: '#8e2f6b', dark: '#f2789f', on: '#2a0713', soft: 'rgba(242,120,159,0.14)' },
    captures: [
      { label: 'Name and contact number', note: 'always' },
      { label: 'Covers and date', note: 'always' },
      { label: 'Preferred sitting', note: 'checked against capacity' },
      { label: 'Dietary or access needs', note: 'passed to the floor' },
      { label: 'Reservation', note: 'confirmed in-call' },
    ],
    features: [
      {
        title: 'Takes the booking without a host at the desk',
        desc: 'Covers, date, sitting and contact number captured and confirmed, so the pass sees the table before service rather than after.',
      },
      {
        title: 'Handles the rush all at once',
        desc: 'Friday at seven is many callers at the same moment. Every one is answered rather than queued behind whoever picked up first.',
      },
      {
        title: 'Answers the questions that fill your evening',
        desc: 'Opening hours, parking, the set menu, whether the kitchen is still on, whether you take walk-ins — from what you gave it, not from a guess.',
      },
      {
        title: 'Passes dietary and access needs to the floor',
        desc: 'Allergies, high chairs, step-free access. Captured on the call and attached to the booking, so nobody finds out at the table.',
      },
      {
        title: 'Speaks your guests’ languages',
        desc: 'Twelve of them, switching mid-sentence, which matters more on a phone line than anywhere else in hospitality.',
      },
      {
        title: 'Rings back for the no-shows',
        desc: 'Confirmation the day before, and an outbound call for a large booking that has not confirmed — the covers you were going to lose anyway.',
      },
    ],
    cta: {
      headline: 'Count the calls you missed last Friday',
      sub: 'We will tell you what they were worth in covers, and what it would take to answer every one.',
    },
  },
  {
    slug: 'education',
    agentType: 'education',
    name: 'Education & coaching',
    title: 'AI call handling for schools, colleges and coaching centres',
    metaDescription:
      'An AI agent that answers admission enquiries, books counselling and demo classes, and handles fee questions from your own material.',
    headline: { lead: 'Admission season,', accented: 'without the engaged tone.' },
    lede:
      'Enquiries arrive in a few intense weeks and a parent who cannot get through has already called the next institute. Our agent answers every one, explains what you actually offer, and books the counselling session.',
    cardBlurb:
      'Admission enquiries answered, counselling and demo classes booked, fee questions handled from your own material.',
    cardMeta: 'Voice · counselling · fees',
    accent: { light: '#5b3fa8', dark: '#a68bff', on: '#130a2b', soft: 'rgba(166,139,255,0.14)' },
    captures: [
      { label: 'Parent or student name', note: 'always' },
      { label: 'Course or class of interest', note: 'always' },
      { label: 'Current standard or background', note: 'always' },
      { label: 'Preferred counselling time', note: 'checked against the calendar' },
      { label: 'Counselling or demo slot', note: 'confirmed in-call' },
    ],
    features: [
      {
        title: 'Survives admission season',
        desc: 'The weeks that decide your intake are the weeks the line is busiest. Every caller is answered at once instead of meeting an engaged tone.',
      },
      {
        title: 'Books counselling and demo classes',
        desc: 'Reads the counsellor’s real availability mid-call, confirms the slot, and messages the parent before they hang up.',
      },
      {
        title: 'Answers fee questions from your own material',
        desc: 'Structure, instalments, scholarships, what is included. From the document you gave it — and it says it does not know rather than quoting a number you never approved.',
      },
      {
        title: 'Talks to parents in their language',
        desc: 'Twelve languages, switching mid-sentence. The person deciding is often not the person who will sit the class.',
      },
      {
        title: 'Separates the serious from the browsing',
        desc: 'Standard, board, target course and timeline captured on the call, so counsellors spend their day on the enquiries that convert.',
      },
      {
        title: 'Follows up without a phone bank',
        desc: 'Outbound reminders for booked counselling, and a call back to the enquiries that went quiet — the ones a busy office never gets to.',
      },
    ],
    cta: {
      headline: 'Bring us one week of admission calls',
      sub: 'We will tell you how many were serious enquiries, and what answering all of them would be worth.',
    },
  },
  {
    slug: 'interior-design',
    agentType: 'interior_design',
    name: 'Interior design',
    title: 'AI enquiry handling for interior design studios',
    metaDescription:
      'An AI agent that answers design enquiries, captures scope, property size, budget band and start date, and books the consultation.',
    headline: { lead: 'Know the project', accented: 'before you take the call.' },
    lede:
      'Most design enquiries are not projects, and finding out costs a designer an hour. Our agent takes the call, captures the scope, the space and the budget band, and books a consultation only when there is something worth consulting about.',
    cardBlurb:
      'Consultations booked with scope, property size, budget band and start date captured before a designer picks up.',
    cardMeta: 'Voice · consultations',
    accent: { light: '#4a6b1f', dark: '#9dc361', on: '#0d1505', soft: 'rgba(157,195,97,0.14)' },
    captures: [
      { label: 'Name and callback number', note: 'always' },
      { label: 'What they want designed', note: 'always' },
      { label: 'Property type and size', note: 'always' },
      { label: 'Budget range', note: 'asked directly' },
      { label: 'When they want to start', note: 'always' },
    ],
    features: [
      {
        title: 'Asks the budget question you would rather not',
        desc: 'Directly, early and without apology — so a designer is never an hour into a conversation about a kitchen that was never funded.',
      },
      {
        title: 'Captures the scope in the caller’s own words',
        desc: 'One room or a whole home, new build or refit, furniture or full turnkey. Written down before anyone senior spends time on it.',
      },
      {
        title: 'Never quotes a price or a date',
        desc: 'Scope drives both, and a number given on a first call becomes the number you are held to. It books the consultation instead.',
      },
      {
        title: 'Speaks to your studio’s work',
        desc: 'Your past projects, your style, your process and your typical timelines — answered from the material you gave it, not invented to please a caller.',
      },
      {
        title: 'Books the consultation live',
        desc: 'Reads the designer’s calendar mid-call, holds the slot, and sends the confirmation before the caller has put the phone down.',
      },
      {
        title: 'Answers while you are on site',
        desc: 'A studio is rarely at its desk. Site days stop being days when the enquiries go to voicemail.',
      },
    ],
    cta: {
      headline: 'Tell us what a wasted consultation costs you',
      sub: 'We will show you what the same enquiries look like once the scope and budget arrive before the meeting does.',
    },
  },
  {
    slug: 'lead-screening',
    agentType: 'lead_screening',
    name: 'Lead screening',
    title: 'AI lead qualification for any business',
    metaDescription:
      'An AI agent that answers every inbound enquiry, qualifies it against your own criteria, and routes only the ones that fit to your team.',
    headline: { lead: 'Your team calls back', accented: 'only the leads that fit.' },
    lede:
      'Not every enquiry is a customer, and finding out is most of the work. Our agent answers all of them, asks your qualifying questions, and hands your team the ones worth their afternoon — whatever business you are in.',
    cardBlurb:
      'For any business: every inbound enquiry qualified against your criteria, so your team only calls back the ones that fit.',
    cardMeta: 'Voice · qualification',
    accent: { light: '#0f6b7a', dark: '#4fc3dd', on: '#04171b', soft: 'rgba(79,195,221,0.14)' },
    captures: [
      { label: 'Name and callback number', note: 'always' },
      { label: 'What they are looking for', note: 'always' },
      { label: 'Company or organisation', note: 'where relevant' },
      { label: 'Budget or size', note: 'your criteria' },
      { label: 'Fit for what you do', note: 'decided in-call' },
    ],
    features: [
      {
        title: 'Qualifies against your criteria, not ours',
        desc: 'You give it the questions that separate a customer from a tyre-kicker in your trade. It asks them conversationally, one at a time, not as a form.',
      },
      {
        title: 'Turns a bad fit away politely',
        desc: 'A caller you cannot help is told so, kindly and early, instead of being logged as a lead somebody has to work through and discard.',
      },
      {
        title: 'Works for any industry',
        desc: 'This is the horizontal one. No trade is baked in — the vocabulary, the criteria and the routing all come from what you gave it.',
      },
      {
        title: 'Routes the good ones immediately',
        desc: 'A qualified lead reaches the right person the moment the call ends, with the transcript, the summary and every captured field attached.',
      },
      {
        title: 'Never promises what you did not authorise',
        desc: 'No pricing, no availability, no callback time it was not given. It captures and routes; your team commits.',
      },
      {
        title: 'Answers at three in the morning',
        desc: 'Inbound does not keep office hours, and a lead answered at 3am is a lead your competitor did not get at 9.',
      },
    ],
    cta: {
      headline: 'Send us your qualifying questions',
      sub: 'We will show you what your inbound looks like once every enquiry has been through them before it reaches your team.',
    },
  },
];

const BY_SLUG = new Map(SOLUTIONS.map((s) => [s.slug, s]));

export function solutionBySlug(slug: string): Solution | undefined {
  return BY_SLUG.get(slug);
}

export function solutionSlugs(): string[] {
  return SOLUTIONS.map((s) => s.slug);
}

/** The other five, for the "we also build for" strip at the foot of each page. */
export function otherSolutions(slug: string): Solution[] {
  return SOLUTIONS.filter((s) => s.slug !== slug);
}
