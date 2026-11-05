import { prisma } from '@/lib/db';
import { getLlmProvider, type ChatMessage } from '@/lib/adapters/llm';
import { retrieveForAgent, formatKnowledgeBlock } from '@/lib/rag/retrieve';
import { sendWhatsApp } from '@/lib/connectors';
import { detectRedFlag, emergencyReply } from '@/lib/portal/red-flags';
import { alertEmergency } from '@/lib/portal/emergency-alert';

// The paid "WhatsApp follow-up chat" add-on. After a call, a caller can text the
// business's WhatsApp number with follow-up questions; this answers them from
// the agent's knowledge base + prompt (Q&A only — no bookings/actions in v1).
//
// Gated on Organization.whatsappChatAddon (owner-enabled, flat monthly fee).
// Because the CALLER messages first, we're inside WhatsApp's 24h service window,
// so replies need no pre-approved template.

const HISTORY_TURNS = 6; // recent turns fed back for multi-message context
const MAX_INBOUND_CHARS = 1000;

// Normalize any inbound sender form ("whatsapp:+1555…", "1555…", "+1555…") to
// bare digits, used as the conversation key + reply address.
function normalizeWaId(from: string): string {
  return from.replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
}

// Handle one inbound WhatsApp message. Returns the reply text (also sent over
// WhatsApp) or null when the add-on is off / nothing to answer.
export async function handleInboundWhatsApp(input: {
  orgId: string;
  from: string;
  text: string;
  // The business number the caller messaged (E.164-ish). When it maps to one of
  // the org's numbers, that number's assigned agent answers.
  toNumber?: string | null;
}): Promise<string | null> {
  // Detection runs on the WHOLE message; only the copy stored and sent to the
  // model is capped. Truncating first would drop a symptom mentioned after a
  // long preamble.
  const full = (input.text || '').trim();
  const text = full.slice(0, MAX_INBOUND_CHARS);
  if (!text) return null;
  const waId = normalizeWaId(input.from);
  if (!waId) return null;

  const org = await prisma.organization.findUnique({
    where: { id: input.orgId },
    select: { whatsappChatAddon: true },
  });
  if (!org?.whatsappChatAddon) return null; // add-on not enabled — ignore

  // Resolve which agent answers: the agent assigned to the number the caller
  // messaged, falling back to the org's most recently updated active agent
  // (e.g. platform-pool numbers that aren't PhoneNumber rows).
  let agent = null;
  const toDigits = (input.toNumber || '').replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  if (toDigits) {
    // Providers vary the number formatting, so match on digits over the org's
    // (small) set of numbers.
    const numbers = await prisma.phoneNumber.findMany({
      where: { workspace: { orgId: input.orgId } },
      select: { e164: true, agent: true },
    });
    const hit = numbers.find((n) => n.e164.replace(/[^\d]/g, '') === toDigits);
    if (hit?.agent && hit.agent.status === 'ACTIVE') agent = hit.agent;
  }
  if (!agent) {
    agent = await prisma.agent.findFirst({
      where: { workspace: { orgId: input.orgId }, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });
  }
  if (!agent) return null;

  // ── Emergency tripwire ──────────────────────────────────────────────────────
  // Same guarantee as the patient chatbot (src/lib/portal/chat.ts): a patient
  // describing an emergency gets 108/112 from a table, not from the model. This
  // channel is a paid add-on for follow-up questions after a call, but nothing
  // stops someone typing a symptom into it, and a prompt instruction cannot be
  // relied on — it competes with everything else in a long prompt and fails
  // precisely when the model is being reassuring.
  //
  // Placed after the agent lookup so the reply can use the agent's language,
  // but before the knowledge retrieval, the model call and the history write.
  const flag = detectRedFlag(full);
  if (flag) {
    const reply = emergencyReply(agent.name || 'the clinic', agent.language);
    void alertEmergency({
      orgId: input.orgId,
      workspaceId: agent.workspaceId,
      channel: 'whatsapp',
      ref: waId,
      patientName: null,
      patientPhone: `+${waId}`,
      businessName: agent.name || 'the clinic',
      agentId: agent.id,
      text,
      flag,
    });
    // Best-effort on both writes: the patient getting the number is the only
    // thing that must happen.
    await sendWhatsApp(input.orgId, `+${waId}`, reply).catch((e) =>
      console.error('[wa-chat] emergency reply send failed', e),
    );
    await prisma.whatsappTurn
      .createMany({
        data: [
          { orgId: input.orgId, waId, role: 'user', text },
          { orgId: input.orgId, waId, role: 'model', text: reply },
        ],
      })
      .catch(() => {});
    return reply;
  }

  try {
    // Pull recent conversation context (oldest first) + retrieve KB for this Q.
    const [priorTurns, chunks] = await Promise.all([
      prisma.whatsappTurn.findMany({
        where: { orgId: input.orgId, waId },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_TURNS,
        select: { role: true, text: true },
      }),
      retrieveForAgent(agent.id, text),
    ]);

    const systemInstruction =
      `${agent.systemPrompt}\n\n` +
      `You are answering a follow-up question over WhatsApp text after a phone call. ` +
      `Keep replies short, friendly and plain-text (no markdown). Answer only from the ` +
      `knowledge below or general help about the business; if you don't know, say you'll ` +
      `have someone follow up.` +
      formatKnowledgeBlock(chunks);

    const history: ChatMessage[] = [
      ...priorTurns.reverse().map((t) => ({ role: t.role === 'model' ? ('model' as const) : ('user' as const), text: t.text })),
      { role: 'user', text },
    ];

    const reply = (
      await getLlmProvider().generate({
        systemInstruction,
        history,
        languageCode: agent.language,
        maxOutputTokens: 400,
      })
    ).trim();
    if (!reply) return null;

    await sendWhatsApp(input.orgId, `+${waId}`, reply);

    // Persist both turns for context on the next message (best-effort).
    await prisma.whatsappTurn.createMany({
      data: [
        { orgId: input.orgId, waId, role: 'user', text },
        { orgId: input.orgId, waId, role: 'model', text: reply },
      ],
    }).catch(() => {});

    return reply;
  } catch (err) {
    console.error('[wa-chat] handler failed', err);
    return null;
  }
}
