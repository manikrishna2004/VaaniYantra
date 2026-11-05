import { redirect } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { WebhooksManager } from '@/components/WebhooksManager';

export const dynamic = 'force-dynamic';

export default async function WebhooksSettingsPage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'integration:read')) redirect('/settings');
  return <WebhooksManager canManage={hasPermission(ctx.role, 'integration:manage')} />;
}
