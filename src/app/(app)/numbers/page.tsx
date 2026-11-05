import { PageHeader } from '@/components/ui';
import { NumbersManager } from '@/components/NumbersManager';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';

export default async function NumbersPage() {
  const ctx = await requireWorkspace();
  // Owner-only: importing a number spends money with a carrier. Staff can still
  // see which numbers exist and where they route.
  const canManage = hasPermission(ctx.role, 'number:write');
  return (
    <>
      <PageHeader
        title="Phone Numbers"
        subtitle="Connect numbers and route inbound calls to an agent."
      />
      <NumbersManager whatsappEnabled={whatsappEnabled()} canManage={canManage} />
    </>
  );
}
