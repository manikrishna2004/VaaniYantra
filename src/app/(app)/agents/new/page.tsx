import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { AgentForm } from '@/components/AgentForm';
import { whatsappEnabled, demoVerticalsAllowed } from '@/lib/flags';
import { requireWorkspace } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

export default async function NewAgentPage() {
  const { user } = await requireWorkspace();
  return (
    <>
      <PageHeader
        title="New agent"
        subtitle="Define the persona, voice, language, and knowledge for your agent."
        action={
          <Link href="/agents" className="text-sm text-muted hover:text-ink">
            ← Back to agents
          </Link>
        }
      />
      <AgentForm
        whatsappEnabled={whatsappEnabled()}
        demoVerticals={demoVerticalsAllowed(user.email)}
      />
    </>
  );
}
