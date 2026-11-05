import type { Agent, Contact, Portal } from '@prisma/client';
import { prisma } from '@/lib/db';
import { detectRedFlag, emergencyReply } from '@/lib/portal/red-flags';
import { alertEmergency } from '@/lib/portal/emergency-alert';
import { getLlmProvider, type ToolHistoryEntry } from '@/lib/adapters/llm';
import { retrieveForAgent, formatKnowledgeBlock } from '@/lib/rag/retrieve';
import { readBookingConfig } from '@/lib/connectors/booking';
import { getPatientProvider, formatRecordsBlock, formatPatientBlock } from '@/lib/patients';
import type { VisitsResult } from '@/lib/patients';
import { allergyStatus, formatAllergyBlock } from '@/lib/patients/allergies';
import { portalTools, type PortalToolContext } from '@/lib/portal/tools';

// The patient-facing chatbot.
//
// Shape is deliberately the same as the WhatsApp follow-up chat
// (src/lib/whatsapp-chat.ts) — recent turns + retrieved knowledge + the agent's
// persona — with two additions: the patient's own visit records are inlined,
// and the model gets tools so it can act on appointments rather than only talk
// about them.

const HISTORY_TURNS = 10;
export const MAX_INBOUND_CHARS = 1000;
// A hard ceiling on the tool loop. Every round is a paid model call against a
// live calendar, and a model that hasn't answered in four rounds is looping,
// not working.
const MAX_TOOL_ROUNDS = 4;

export type PortalChatResult = {
  reply: string;
  // Set when a tool changed something, so the UI can refresh the records and
  // appointments panels instead of making the patient reload.
  mutated: boolean;
};

function buildSystemInstruction(input: {
  portal: Portal;
  contact: Contact;
  agent: Agent | null;
  recordsBlock: string;
  knowledgeBlock: string;
  businessName: string;
  canBook: boolean;
}): string {
  const persona = input.agent?.systemPrompt?.trim();
  const business = input.businessName || 'the clinic';
  // Same reason as the voice agent (src/lib/voice/live.ts): the model has no
  // clock, so without being told the date it cannot produce the YYYY-MM-DD that
  // check_availability expects, and never passes one.
  const bookingTz = input.agent ? readBookingConfig(input.agent).timezone : 'Asia/Kolkata';
  const todayIso = new Intl.DateTimeFormat('en-CA', {
    timeZone: bookingTz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  return [
    persona || `You are the assistant for ${business}.`,
    '',
    // The old wording ("they opened this from a link, so you already know who
    // they are") was security theatre over a forwardable bearer link. They have
    // now verified their phone number with a one-time code, so the instruction
    // is simply a statement of fact.
    `You are chatting in a text window with ${input.contact.name}, a patient of ${business}. ` +
      `They have already signed in by verifying their mobile number, so greet them by name and answer about ` +
      `their own records directly — never ask them to confirm their identity, phone number, or date of birth.`,
    '',
    'How to reply:',
    '- Be warm, brief and plain. Short paragraphs, no markdown headings, no bullet symbols unless listing medicines.',
    '- Answer from the patient record and knowledge below. Never invent a medicine, dosage, diagnosis or timing.',
    "- If something isn't in either, say you'll have the clinic follow up — do not guess.",
    '- You are not a doctor. Read back what was prescribed and advised, but never give new medical advice, ' +
      'change a dose, or interpret symptoms. If they describe a new or worsening problem, tell them to contact ' +
      `${business} directly, and to seek urgent care if it is serious.`,
    input.canBook
      ? `- Today is ${todayIso} (${bookingTz}). Work out any date the patient names from that — "tomorrow", ` +
        '"next Monday", "the 14th" — and pass it to check_availability as the date argument. If that day has ' +
        'nothing open it will tell you so: say the day is full and offer another, never quietly offer times from ' +
        'a different day.\n' +
        '- You can check real availability and book, move or cancel their appointments using your tools. Always confirm the exact time with the patient before booking or cancelling.'
      : '- You cannot change appointments here; ask them to call the clinic for that.',
    input.recordsBlock,
    input.knowledgeBlock,
  ].join('\n');
}

/**
 * Answer one patient message. Runs the tool loop to completion and persists
 * both sides of the exchange for context on the next message.
 */
export async function handlePortalMessage(input: {
  portal: Portal;
  contact: Contact;
  text: string;
}): Promise<PortalChatResult> {
  // Detection runs on the WHOLE message; only the copy we store and send to the
  // model is capped. Truncating first would drop a symptom mentioned after a
  // long preamble — the one message where losing it matters most.
  const full = input.text.trim();
  const text = full.slice(0, MAX_INBOUND_CHARS);
  // Nothing to record for an empty message, so this early-out deliberately does
  // NOT go through finish() below.
  if (!text) return { reply: '', mutated: false };

  /** Record both sides of the exchange and answer. */
  const finish = async (reply: string, mutated: boolean): Promise<PortalChatResult> => {
    await prisma.portalChatTurn
      .createMany({
        data: [
          { portalId: input.portal.id, contactId: input.contact.id, role: 'user', text },
          { portalId: input.portal.id, contactId: input.contact.id, role: 'model', text: reply },
        ],
      })
      .catch((e) => console.error('[portal-chat] history persist failed', e));
    return { reply, mutated };
  };

  // ── Emergency tripwire ────────────────────────────────────────────────────
  // Runs before the provider, the knowledge base, the tool loop and the model.
  // The detection itself is pure and synchronous, and everything it needs to
  // answer is already in hand — so a patient describing chest pain still gets
  // 108/112 even when the database is degraded and the rest of this function
  // would fail.
  //
  // A prompt instruction cannot do this job: it is advisory, it competes with
  // everything else in a long prompt, and it fails precisely when the model is
  // being reassuring. See src/lib/portal/red-flags.ts.
  const flag = detectRedFlag(full);
  if (flag) {
    void alertEmergency({
      orgId: input.contact.orgId,
      workspaceId: input.portal.workspaceId,
      channel: 'chatbot',
      ref: input.portal.slug,
      patientName: input.contact.name,
      patientPhone: input.contact.phone,
      businessName: input.portal.name,
      agentId: input.portal.agentId,
      text,
      flag,
    });
    // One primary-key lookup for the language, and only that — a failure here
    // degrades to English rather than costing the patient their reply. The
    // emergency numbers are digits, so they survive either way.
    const language = input.portal.agentId
      ? await prisma.agent
          .findUnique({ where: { id: input.portal.agentId }, select: { language: true } })
          .then((a) => a?.language ?? null)
          .catch(() => null)
      : null;
    // Persisted like any other turn, so the clinic can see what was said.
    return finish(emergencyReply(input.portal.name, language), false);
  }

  const agent = input.portal.agentId
    ? await prisma.agent.findUnique({ where: { id: input.portal.agentId } })
    : null;

  const provider = await getPatientProvider(input.contact.orgId);

  const [priorTurns, visits, chunks, tools, allergies] = await Promise.all([
    prisma.portalChatTurn.findMany({
      where: { contactId: input.contact.id, portalId: input.portal.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS,
      select: { role: true, text: true },
    }),
    input.portal.allowRecords
      ? provider.listPatientVisits(input.contact.id)
      : Promise.resolve({ status: 'empty' } as VisitsResult),
    agent ? retrieveForAgent(agent.id, text) : Promise.resolve([]),
    portalTools(input.portal, agent, provider),
    prisma.allergy.findMany({ where: { contactId: input.contact.id } }).catch(() => []),
  ]);

  const cfg = agent ? readBookingConfig(agent) : null;
  const businessName = cfg?.businessName || input.portal.name;

  const systemInstruction = buildSystemInstruction({
    portal: input.portal,
    contact: input.contact,
    agent,
    // Demographics and allergies ride along with the records: the model needs
    // to know whether it is talking about a four-year-old, and it must never be
    // left to infer "no allergies" from a silent gap.
    recordsBlock:
      formatPatientBlock(input.contact) +
      formatAllergyBlock(allergyStatus(input.contact, allergies)) +
      (input.portal.allowRecords ? formatRecordsBlock(visits, cfg?.timezone) : ''),
    knowledgeBlock: formatKnowledgeBlock(chunks),
    businessName,
    canBook: tools.length > 0,
  });

  const history: ToolHistoryEntry[] = [
    ...priorTurns
      .reverse()
      .map((t) => ({ role: t.role === 'model' ? ('model' as const) : ('user' as const), text: t.text })),
    { role: 'user' as const, text },
  ];

  let reply = '';
  let mutated = false;

  try {
    if (tools.length === 0) {
      // No tools to offer — a single generate is cheaper and has one less way
      // to go wrong than a loop that can never call anything.
      reply = (
        await getLlmProvider().generate({
          systemInstruction,
          history: history.filter((h) => h.role === 'user' || h.role === 'model') as { role: 'user' | 'model'; text: string }[],
          languageCode: agent?.language,
          maxOutputTokens: 600,
        })
      ).trim();
    } else {
      const toolCtx: PortalToolContext = {
        portal: input.portal,
        contact: input.contact,
        agent: agent!,
        cfg: cfg!,
      };
      const byName = new Map(tools.map((t) => [t.spec.name, t]));

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const turn = await getLlmProvider().generateWithTools({
          systemInstruction,
          history,
          tools: tools.map((t) => t.spec),
          languageCode: agent?.language,
          maxOutputTokens: 600,
        });

        if (turn.calls.length === 0) {
          reply = turn.text.trim();
          break;
        }

        for (const call of turn.calls) {
          const tool = byName.get(call.name);
          history.push({ role: 'call', name: call.name, args: call.args });
          if (!tool) {
            history.push({ role: 'tool', name: call.name, response: { ok: false, error: 'Unknown tool.' } });
            continue;
          }
          let response: Record<string, unknown>;
          try {
            response = await tool.handler(call.args, toolCtx);
          } catch (err) {
            console.error('[portal-chat] tool', call.name, 'threw', err);
            response = { ok: false, error: 'That did not work. Ask the patient to try again shortly.' };
          }
          if (response.ok === true && call.name !== 'check_availability' && call.name !== 'my_appointments') {
            mutated = true;
          }
          history.push({ role: 'tool', name: call.name, response });
        }
        // Carry any narration forward so the final answer doesn't repeat it.
        if (turn.text.trim()) reply = turn.text.trim();
      }
    }
  } catch (err) {
    console.error('[portal-chat] generation failed', err);
    return {
      reply: 'Sorry — I could not answer that just now. Please try again in a moment, or call the clinic.',
      mutated: false,
    };
  }

  if (!reply) {
    reply = mutated
      ? 'Done — I have updated that for you.'
      : "I'm not sure about that one. I'll ask the clinic to follow up with you.";
  }

  return finish(reply, mutated);
}
