import Link from 'next/link';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PageHeader, Button, EmptyState } from '@/components/ui';
import { AgentCard } from '@/components/AgentCard';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const ctx = await requireWorkspace();
  // Agents are ADMIN and OWNER only. Hiding the nav link is not enough — the
  // URL has to refuse too. Everyone who reaches this page can therefore manage
  // what is on it, so there is no read-only mode left to render.
  if (!hasPermission(ctx.role, 'agent:write')) notFound();
  const { workspace } = ctx;
  const agents = await prisma.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { calls: true, knowledgeLinks: true, phoneNumbers: true } } },
  });

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Your AI phone agents. Define behavior, voice, language, and knowledge."
        action={
          (
            <Link href="/agents/new">
              <Button>+ New Agent</Button>
            </Link>
          )
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Create your first AI phone agent to start handling calls."
          action={
            (
              <Link href="/agents/new">
                <Button>Create an agent</Button>
              </Link>
            )
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
    </>
  );
}
