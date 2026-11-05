import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PageHeader } from '@/components/ui';
import { ChatbotManager } from '@/components/ChatbotManager';

export const dynamic = 'force-dynamic';

export default async function ChatbotPage() {
  const ctx = await requireWorkspace();
  return (
    <>
      <PageHeader
        title="Patient Chatbot"
        subtitle="Your own chatbot, on your own link. Patients open it from their appointment confirmation to re-read a prescription, ask a follow-up question, or move an appointment — answered from your knowledge base and their own records."
      />
      <ChatbotManager canManage={hasPermission(ctx.role, 'agent:write')} />
    </>
  );
}
