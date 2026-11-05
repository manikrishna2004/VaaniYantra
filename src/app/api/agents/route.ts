import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { deny } from '@/lib/auth/api';
import { ownsAll } from '@/lib/auth/tenant';
import { audit } from '@/lib/audit';
import { agentInputSchema, readJson } from '@/lib/validation';
import { checkCreateAllowed, limitMessage } from '@/lib/billing/catalogue';
import { geminiKeyUpdate, withoutGeminiKey } from '@/lib/agent-gemini';
import { demoVerticalsAllowed } from '@/lib/flags';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'agent:read')) {
    return NextResponse.json({ error: 'You do not have access to agents.' }, { status: 403 });
  }

  const agents = await prisma.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { calls: true, knowledgeLinks: true, phoneNumbers: true } },
    },
  });
  // The rows go to the browser wholesale, so the encrypted key must not ride along.
  return NextResponse.json(agents.map(withoutGeminiKey));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace();
  // Building the agent that answers the clinic's phone is a supervisory act.
  // This route had no permission check at all, so any signed-in member — a
  // VIEWER, or a doctor — could create one.
  const denied = deny(ctx, 'agent:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const json = await readJson(req);
  if (json === null) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const parsed = agentInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const gate = await checkCreateAllowed(ctx.org.id, 'agents');
  if (!gate.allowed) {
    return NextResponse.json({ error: limitMessage('agents', gate.limit, gate.plan) }, { status: 403 });
  }

  // Agents can be created (and tested in the browser/demo) without a phone
  // number — a number is only required to go live on real calls.
  const { documentIds, geminiApiKey, ...data } = parsed.data;

  // Only an allow-listed account may attach a per-agent Gemini key. Silently
  // dropping it for everyone else keeps the field inert if a crafted request
  // reaches this route from an ordinary customer's session.
  const ownKey = demoVerticalsAllowed(ctx.user.email) ? geminiApiKey : undefined;

  // documentIds arrives from the client, so it must be proved to belong to this
  // workspace before it is linked: knowledge is retrieved into the agent's
  // prompt on every call and chat, and an unchecked id would read another
  // clinic's documents out through this agent.
  if (documentIds?.length && !(await ownsAll(prisma.document, workspace.id, documentIds))) {
    return NextResponse.json(
      { error: 'One or more of those knowledge documents do not exist.' },
      { status: 400 },
    );
  }

  const agent = await prisma.agent.create({
    data: {
      workspaceId: workspace.id,
      name: data.name,
      description: data.description ?? null,
      systemPrompt: data.systemPrompt,
      greeting: data.greeting ?? null,
      language: data.language,
      voice: data.voice,
      languageMode: data.languageMode ?? 'single',
      geminiVoice: data.geminiVoice ?? 'Aoede',
      agentType: data.agentType ?? 'general',
      industryLabel: data.industryLabel ?? null,
      endCallInstructions: data.endCallInstructions ?? null,
      recordingDisclosure: data.recordingDisclosure ?? false,
      voiceProvider: data.voiceProvider ?? 'google',
      voiceStages: data.voiceStages ?? undefined,
      direction: data.direction,
      status: data.status ?? 'ACTIVE',
      maxCallSeconds: data.maxCallSeconds ?? 600,
      temperature: data.temperature ?? 0.6,
      businessHours: data.businessHours ?? undefined,
      afterHoursMessage: data.afterHoursMessage ?? null,
      fallbackMessage: data.fallbackMessage ?? null,
      transferEnabled: data.transferEnabled ?? false,
      transferNumber: data.transferNumber || null,
      transferMessage: data.transferMessage ?? null,
      transferTriggers: data.transferTriggers ?? null,
      variables: data.variables ?? undefined,
      bookingConfig: data.bookingConfig ?? undefined,
      outcomeConfig: data.outcomeConfig ?? undefined,
      ...geminiKeyUpdate(ownKey),
      knowledgeLinks: documentIds?.length
        ? { create: documentIds.map((documentId) => ({ documentId })) }
        : undefined,
    },
  });
  await audit(ctx, 'agent.created', { targetType: 'Agent', targetId: agent.id, metadata: { name: agent.name }, req });
  return NextResponse.json(withoutGeminiKey(agent), { status: 201 });
}
