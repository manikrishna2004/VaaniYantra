import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { PageHeader, Card, Badge } from '@/components/ui';
import { AgentForm } from '@/components/AgentForm';
import { AgentActions } from '@/components/AgentActions';
import { getLanguage, GEMINI_VOICES } from '@/lib/constants';
import { whatsappEnabled, demoVerticalsAllowed } from '@/lib/flags';

export const dynamic = 'force-dynamic';

// Badge wording per language mode. 'single' is the default and gets no badge.
const LANGUAGE_MODE_BADGE: Record<string, string> = {
  hybrid: 'hybrid language',
  auto: 'auto language',
  multi: 'multilingual',
};

export default async function AgentDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { workspace, user } = await requireWorkspace();
  const agent = await prisma.agent.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: {
      knowledgeLinks: { select: { documentId: true } },
      _count: { select: { calls: true, phoneNumbers: true } },
    },
  });
  if (!agent) notFound();

  const lang = getLanguage(agent.language);
  // The realtime pipeline speaks with the Gemini Live voice, so show that —
  // not the legacy Google TTS `voice` field (which defaulted to a fixed voice).
  const voiceLabel =
    GEMINI_VOICES.find((g) => g.id === (agent as any).geminiVoice)?.label ?? (agent as any).geminiVoice ?? 'Aanya';

  return (
    <>
      <PageHeader
        title={agent.name}
        subtitle={agent.description ?? 'Edit this agent or place a test call.'}
        action={
          <Link href="/agents" className="text-sm text-muted hover:text-ink">
            ← Back to agents
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={agent.status === 'ACTIVE' ? 'success' : 'neutral'}>{agent.status.toLowerCase()}</Badge>
        <Badge tone="primary">{lang?.label ?? agent.language}</Badge>
        <Badge tone="accent">voice: {voiceLabel}</Badge>
        {agent.languageMode !== 'single' && (
          <Badge tone="primary">{LANGUAGE_MODE_BADGE[agent.languageMode] ?? 'auto language'}</Badge>
        )}
        {agent.voiceProvider !== 'google' && <Badge>{agent.voiceProvider}</Badge>}
        {(agent.businessHours as any)?.enabled && <Badge>business hours</Badge>}
        {agent.transferEnabled && <Badge>transfer</Badge>}
        <Badge>{agent.direction.toLowerCase()}</Badge>
        <span className="text-xs text-muted">{agent._count.calls} calls · {agent._count.phoneNumbers} numbers</span>
      </div>

      {agent._count.phoneNumbers === 0 && (
        <div className="mb-6 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-ink-soft">
          This agent is ready to test below. To take real phone calls,{' '}
          <Link href="/numbers" className="text-primary underline">connect a phone number</Link> and assign it to this
          agent.
        </div>
      )}

      <Card className="mb-6">
        <AgentActions agentId={agent.id} agentName={agent.name} />
      </Card>

      <AgentForm
        whatsappEnabled={whatsappEnabled()}
        demoVerticals={demoVerticalsAllowed(user.email)}
        hasGeminiKey={Boolean((agent as any).geminiApiKey)}
        initial={{
          id: agent.id,
          name: agent.name,
          description: agent.description ?? '',
          systemPrompt: agent.systemPrompt,
          greeting: agent.greeting ?? '',
          language: agent.language,
          voice: agent.voice,
          languageMode: agent.languageMode as 'single' | 'hybrid' | 'auto' | 'multi',
          geminiVoice: (agent as any).geminiVoice ?? 'Aoede',
          agentType: ((agent as any).agentType ?? 'general') as any,
          industryLabel: (agent as any).industryLabel ?? '',
          endCallInstructions: (agent as any).endCallInstructions ?? '',
          direction: agent.direction as 'INBOUND' | 'OUTBOUND' | 'BOTH',
          status: agent.status as 'ACTIVE' | 'PAUSED',
          maxCallSeconds: agent.maxCallSeconds,
          temperature: agent.temperature,
          documentIds: agent.knowledgeLinks.map((k) => k.documentId),
          businessHours: agent.businessHours as any,
          afterHoursMessage: agent.afterHoursMessage ?? '',
          fallbackMessage: agent.fallbackMessage ?? '',
          transferEnabled: agent.transferEnabled,
          transferNumber: agent.transferNumber ?? '',
          transferMessage: agent.transferMessage ?? '',
          transferTriggers: agent.transferTriggers ?? '',
          variables: (agent.variables as any) ?? [],
          bookingConfig: (agent as any).bookingConfig ?? undefined,
          outcomeConfig: (agent as any).outcomeConfig ?? undefined,
        }}
      />
    </>
  );
}
