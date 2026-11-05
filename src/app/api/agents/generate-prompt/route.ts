import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { getLlmProvider } from '@/lib/adapters/llm';
import { getConnectorStatus } from '@/lib/connectors';
import { whatsappEnabled } from '@/lib/flags';
import { agentTypeLabel } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// #3: turn a plain-English description of the desired agent into a polished
// system prompt, aware of which connectors are available for post-call actions.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'agent:write');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { description?: string; agentType?: string; industryLabel?: string };
  const desc = body.description?.trim();
  if (!desc || desc.length < 8) {
    return NextResponse.json({ error: 'Describe what the agent should do (a sentence or two).' }, { status: 400 });
  }

  const conn = await getConnectorStatus(ctx.org.id).catch(() => null);
  const actions: string[] = [];
  if (conn?.google.connected) {
    actions.push('book Google Calendar appointments');
  }
  // WhatsApp needs no per-org connection — the platform's shared sender is
  // always available, so it's offered whenever the feature flag is on.
  if (whatsappEnabled()) actions.push('send WhatsApp confirmations/follow-ups');
  const connectorLine = actions.length
    ? ` After the call, the agent can ${actions.join(', ')} — instruct it to tell the caller when it will do so (e.g., "I'll text you a confirmation").`
    : '';

  try {
    // Send the human label, not the raw slug — "Diagnostic Lab / Imaging" is
    // something the model can reason about; "diagnostics" is a guess.
    const practice =
      (body.agentType === 'other' && body.industryLabel?.trim()) || agentTypeLabel(body.agentType);

    const prompt = await getLlmProvider().generate({
      systemInstruction:
        'You write system prompts for AI phone agents that answer calls for clinics and hospitals. Given a short ' +
        'description and the practice type, produce a clear, professional system prompt written in the second person ' +
        '("You are …") that defines the agent\'s persona, goal, tone, and how to handle the call. ' +
        'The prompt you write MUST instruct the agent never to give medical advice, never to interpret symptoms or ' +
        'test results, and never to suggest medicines — anything clinical becomes an appointment with the doctor — ' +
        'and to tell a caller describing an emergency to seek emergency care immediately. ' +
        'Keep it under 250 words, natural for a phone conversation. ' +
        'Output ONLY the prompt text — no preamble, no markdown.',
      history: [
        {
          role: 'user',
          text: `Practice type: ${practice}\nWhat it should do: ${desc}.${connectorLine}`,
        },
      ],
      temperature: 0.4,
      maxOutputTokens: 500,
    });
    return NextResponse.json({ prompt: prompt.trim() });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Could not generate a prompt right now (the AI model may be rate-limited). You can write it manually.' },
      { status: 502 },
    );
  }
}
