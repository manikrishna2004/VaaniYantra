import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { AppointmentsPage, type AppointmentsTab } from '@/components/AppointmentsPage';

export const dynamic = 'force-dynamic';

export default async function Page(props: { searchParams: Promise<{ tab?: string }> }) {
  const [ctx, params] = await Promise.all([requireWorkspace(), props.searchParams]);
  const tab: AppointmentsTab = params.tab === 'updates' ? 'updates' : 'appointments';

  return <AppointmentsPage canManage={hasPermission(ctx.role, 'call:write')} defaultTab={tab} />;
}
