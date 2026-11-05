import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { deny } from '@/lib/auth/api';
import { ownsAll } from '@/lib/auth/tenant';
import { audit } from '@/lib/audit';
import { agentInputSchema, readJson } from '@/lib/validation';
import { geminiKeyUpdate, withoutGeminiKey } from '@/lib/agent-gemini';
import { demoVerticalsAllowed } from '@/lib/flags';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, props: Params) {
  const params = await props.params;
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'agent:read')) {
    return NextResponse.json({ error: 'You do not have access to agents.' }, { status: 403 });
  }
  const agent = await prisma.agent.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: {
      knowledgeLinks: { include: { document: true } },
      phoneNumbers: true,
      _count: { select: { calls: true } },
    },
  });
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(withoutGeminiKey(agent));
}

export async function PATCH(req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'agent:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const existing = await prisma.agent.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const json = await readJson(req);
  if (json === null) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const parsed = agentInputSchema.partial().safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { documentIds, geminiApiKey, ...data } = parsed.data;

  // As on create: only an allow-listed account can set or clear a per-agent key.
  const ownKey = demoVerticalsAllowed(ctx.user.email) ? geminiApiKey : undefined;

  // Drain the retired expert list as agents are saved.
  //
  // Doctors moved to the Doctor table; `bookingConfig.experts` is no longer read
  // by anything. Zod still ACCEPTS it, so an older browser tab holding a stale
  // form does not get a 400 — but persisting it again would leave a dead list
  // sitting in the column, looking authoritative to the next person who reads
  // the row. Stripping it here means the data clears itself as clinics edit
  // their agents, with no separate cleanup migration to remember.
  if (data.bookingConfig && typeof data.bookingConfig === 'object') {
    delete (data.bookingConfig as Record<string, unknown>).experts;
  }

  // Prove ownership BEFORE touching the existing links. The replace below is a
  // delete followed by a create, so validating late would leave a rejected
  // request having already wiped the customer's knowledge configuration — and
  // an unchecked id would point this agent at another clinic's documents.
  if (documentIds?.length && !(await ownsAll(prisma.document, workspace.id, documentIds))) {
    return NextResponse.json(
      { error: 'One or more of those knowledge documents do not exist.' },
      { status: 400 },
    );
  }

  // Replace knowledge links if documentIds was provided.
  if (documentIds) {
    await prisma.agentKnowledge.deleteMany({ where: { agentId: params.id } });
    if (documentIds.length) {
      await prisma.agentKnowledge.createMany({
        data: documentIds.map((documentId) => ({ agentId: params.id, documentId })),
      });
    }
  }

  const agent = await prisma.agent.update({
    where: { id: params.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
      ...(data.greeting !== undefined ? { greeting: data.greeting } : {}),
      ...(data.language !== undefined ? { language: data.language } : {}),
      ...(data.voice !== undefined ? { voice: data.voice } : {}),
      ...(data.languageMode !== undefined ? { languageMode: data.languageMode } : {}),
      ...(data.geminiVoice !== undefined ? { geminiVoice: data.geminiVoice } : {}),
      ...(data.agentType !== undefined ? { agentType: data.agentType } : {}),
      ...(data.industryLabel !== undefined ? { industryLabel: data.industryLabel } : {}),
      ...(data.endCallInstructions !== undefined ? { endCallInstructions: data.endCallInstructions } : {}),
      ...(data.recordingDisclosure !== undefined ? { recordingDisclosure: data.recordingDisclosure } : {}),
      ...(data.voiceProvider !== undefined ? { voiceProvider: data.voiceProvider } : {}),
      ...(data.voiceStages !== undefined ? { voiceStages: data.voiceStages ?? Prisma.JsonNull } : {}),
      ...(data.businessHours !== undefined ? { businessHours: data.businessHours ?? Prisma.JsonNull } : {}),
      ...(data.afterHoursMessage !== undefined ? { afterHoursMessage: data.afterHoursMessage } : {}),
      ...(data.fallbackMessage !== undefined ? { fallbackMessage: data.fallbackMessage } : {}),
      ...(data.transferEnabled !== undefined ? { transferEnabled: data.transferEnabled } : {}),
      ...(data.transferNumber !== undefined ? { transferNumber: data.transferNumber || null } : {}),
      ...(data.transferMessage !== undefined ? { transferMessage: data.transferMessage } : {}),
      ...(data.transferTriggers !== undefined ? { transferTriggers: data.transferTriggers } : {}),
      ...(data.variables !== undefined ? { variables: data.variables ?? Prisma.JsonNull } : {}),
      ...(data.bookingConfig !== undefined ? { bookingConfig: data.bookingConfig ?? Prisma.JsonNull } : {}),
      ...(data.outcomeConfig !== undefined ? { outcomeConfig: data.outcomeConfig ?? Prisma.JsonNull } : {}),
      ...(data.direction !== undefined ? { direction: data.direction } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.maxCallSeconds !== undefined ? { maxCallSeconds: data.maxCallSeconds } : {}),
      ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
      ...geminiKeyUpdate(ownKey),
    },
  });
  return NextResponse.json(withoutGeminiKey(agent));
}

export async function DELETE(req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'agent:delete');
  if (denied) return denied;
  const existing = await prisma.agent.findFirst({
    where: { id: params.id, workspaceId: ctx.workspace.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.agent.delete({ where: { id: params.id } });
  await audit(ctx, 'agent.deleted', { targetType: 'Agent', targetId: params.id, metadata: { name: existing.name }, req });
  return NextResponse.json({ ok: true });
}
