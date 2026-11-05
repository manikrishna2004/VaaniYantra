import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { TeamManager } from '@/components/TeamManager';
import { DoctorsManager } from '@/components/DoctorsManager';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const ctx = await requireWorkspace();
  const canManage = hasPermission(ctx.role, 'member:manage');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Team</h1>
        <p className="mt-1 text-sm text-muted">
          People in <span className="text-ink">{ctx.org.name}</span> and their roles.
        </p>
      </div>
      <TeamManager canManage={canManage} yourRole={ctx.role} />
      <DoctorsManager canManage={canManage} />
    </div>
  );
}
