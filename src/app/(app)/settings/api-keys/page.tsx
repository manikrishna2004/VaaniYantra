import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { notFound } from 'next/navigation';
import { ApiKeysManager } from '@/components/ApiKeysManager';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'apikey:read')) notFound();
  const apiBase = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  return (
    <ApiKeysManager canManage={hasPermission(ctx.role, 'apikey:manage')} apiBase={apiBase} />
  );
}
