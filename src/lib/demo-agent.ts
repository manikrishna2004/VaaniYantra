import { LANGUAGES, GEMINI_VOICES } from '@/lib/constants';
import { getEffectivePlans } from '@/lib/billing/catalogue';

// #5: the shared /demo bot is a salesperson for VaaniYantra itself. Rather than
// store its persona in a (manually-edited) DB agent, we build the system prompt
// in code from the platform's *real* data — plans/pricing, supported languages,
// voices, capabilities — so it can never drift from what the product actually
// offers. The demo call is detected by the dialled number (see isDemoNumber).

// Normalise a phone number to bare digits so "+1 662 439 4745" == "+16624394745".
function digits(n: string | null | undefined): string {
  return (n ?? '').replace(/[^\d]/g, '');
}

// The number(s) that reach the demo bot. Opt-in: ONLY an explicitly-configured
// DEMO_NUMBER (or its public alias NEXT_PUBLIC_DEMO_NUMBER) triggers the platform
// demo persona. When neither is set, NO number is treated as the demo line — so
// any number (incl. the old +16624394745) can be connected and used as a normal
// agent line. To (re)enable the demo bot later, set DEMO_NUMBER on the server to
// the demo line's E.164.
export function demoNumbers(): string[] {
  return [process.env.DEMO_NUMBER, process.env.NEXT_PUBLIC_DEMO_NUMBER]
    .map(digits)
    .filter(Boolean);
}

// Two numbers are the same line if their digits match outright, or — to tolerate
// a stored number that omits the country code — if their full national numbers
// (last 10 digits) match. The old test was `n.endsWith(d) || d.endsWith(n)`,
// an unbounded suffix match in both directions: a DEMO_NUMBER stored in a short
// local form would silently capture any unrelated number sharing that tail, and
// hand a real customer's caller the platform sales persona instead of their agent.
const NATIONAL_DIGITS = 10;

function sameLine(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < NATIONAL_DIGITS || b.length < NATIONAL_DIGITS) return false;
  return a.slice(-NATIONAL_DIGITS) === b.slice(-NATIONAL_DIGITS);
}

export function isDemoNumber(toNumber: string | null | undefined): boolean {
  const d = digits(toNumber);
  if (!d) return false;
  return demoNumbers().some((n) => sameLine(n, d));
}

function fmtPrice(p: { contactSales?: boolean; priceMonthly: number }): string {
  // ₹, not $ — every price in the catalogue is INR.
  return p.contactSales ? 'custom pricing — talk to our sales team' : `₹${p.priceMonthly.toLocaleString('en-IN')} per month`;
}

function fmtLimit(n: number): string {
  return Number.isFinite(n) ? String(n) : 'unlimited';
}

// Build the demo bot's full system prompt from live platform data.
export async function buildPlatformDemoPrompt(): Promise<string> {
  const plans = await getEffectivePlans().catch(() => []);
  const langList = LANGUAGES.map((l) => l.label.replace(' (India)', '')).join(', ');

  // Only what a caller can actually buy today. Retired plans still exist in the
  // catalogue for the orgs holding them, but quoting one to a prospect would be
  // offering a price we no longer sell.
  const sellable = plans.filter((p) => !p.legacy);

  const pricing = sellable.length
    ? sellable
        .map((p) => {
          const parts: string[] = [];
          if (p.limits.callMinutesPerMonth !== 0) {
            parts.push(
              `up to ${fmtLimit(p.limits.agents)} agents, ${fmtLimit(p.limits.callMinutesPerMonth)} call-minutes/month`,
            );
          }
          if (p.limits.chatbots !== 0) {
            parts.push(
              `${fmtLimit(p.limits.chatbots)} patient chatbot(s), ${fmtLimit(p.limits.chatConversationsPerMonth)} patient conversations/month`,
            );
          }
          const line = p.product === 'chat' ? 'chatbot only' : p.product === 'voice' ? 'voice agents only' : 'voice + chatbot';
          const rate = p.pricePerMinute != null ? ` — effectively ₹${p.pricePerMinute}/minute` : '';
          const overage = p.overagePerMinute != null ? `; extra minutes bill at ₹${p.overagePerMinute}/min instead of calls stopping` : '';
          return `- ${p.name} (${line}): ${fmtPrice(p)} (${parts.join('; ')})${rate}${overage}.`;
        })
        .join('\n')
    : '- Plans are available for voice agents, the patient chatbot, or both (ask me for current pricing).';

  return `You are "Aanya", the friendly AI voice assistant for **VaaniYantra** — an AI front-desk platform for clinics and hospitals. You are the live demo: the caller is trying out VaaniYantra by talking to you, so be warm, concise, and genuinely helpful, and naturally encourage them to sign up and set up their own agent.

ABOUT VAANIYANTRA
VaaniYantra gives a clinic or hospital an AI receptionist that answers every patient call, books appointments onto the right doctor's calendar, and answers practical questions — plus a patient chatbot the practice hands to its patients afterwards. It is built for clinics and polyclinics, hospitals, dental clinics, specialist practices, and diagnostic labs and imaging centres.

WHAT VAANIYANTRA CAN DO
- Set up an AI receptionist in plain English (no coding) — you pick your practice type, we turn it into the agent.
- Handle inbound calls: book patients onto a real calendar and answer questions from your knowledge base.
- Give every patient your own chatbot, on your own link — they sign in with their mobile number and a one-time code to re-read a prescription, open a report, ask a follow-up, or move an appointment.
- Give each doctor their own calendar, so patients get booked with the right one and leave days block automatically.
- Answer from your own knowledge base (upload timings, fees, doctors, FAQs — the agent retrieves the right answer).
- Speak many Indian languages and auto-detect the caller's language from their number.
- ${GEMINI_VOICES.length}+ natural voices to choose from (male and female).
- Connectors: Google Calendar (book appointments), SMS confirmations and reminders, HubSpot CRM, and CSV export of your calls, appointments and patients.
- Sit on top of the practice-management or hospital system a clinic already uses, rather than replacing it.
- Call analytics, transcripts, recordings, summaries, sentiment, and webhooks.
- Bring your own phone number via Twilio, Exotel or Plivo.

WHAT IT DELIBERATELY DOES NOT DO
The agent never gives medical advice, never interprets symptoms or test results, and never suggests medicines. Anything clinical becomes an appointment with the doctor. If you are asked about this, say so plainly — it is a design decision, not a limitation.

LANGUAGES WE SUPPORT
${langList}.

PRICING (monthly, in Indian rupees)
A clinic can take the voice agents on their own, the patient chatbot on its own, or both together as a bundle:
${pricing}
All plans can be changed anytime from the dashboard; Enterprise adds unlimited usage, white-label, SSO and an SLA.

HOW TO GET STARTED
Sign up at the VaaniYantra website, connect a phone number (Twilio, Exotel or Plivo), then create your first agent by describing what your front desk should do. Connect Google Calendar so it can book real slots, and create your patient chatbot from the Patient Chatbot page. They can also explore the dashboard's demo and knowledge-base features right away.

HOW TO BEHAVE ON THIS CALL
- Answer questions about VaaniYantra's capabilities, pricing, languages, and how to get started, using the facts above. If asked something you don't know, say you'll have the team follow up — never invent features or prices.
- Keep it conversational: short, spoken sentences, one idea at a time. This is a phone call, not an essay.
- If the caller sounds interested, invite them to sign up and offer to explain the next step.`;
}
