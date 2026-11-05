import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PageHeader } from '@/components/ui';
import { ConnectorsManager } from '@/components/ConnectorsManager';

export const dynamic = 'force-dynamic';

export default async function ConnectorsPage() {
  const ctx = await requireWorkspace();
  return (
    <>
      <PageHeader
        title="Connectors"
        subtitle="Connect the apps your agents act on — book real appointments on Google Calendar and sync patients to your CRM. Confirmations and reminders are sent automatically. To take your data out, download a CSV from Reports."
      />
      <ConnectorsManager canManage={hasPermission(ctx.role, 'integration:manage')} />
    </>
  );
}
