import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PageHeader } from '@/components/ui';
import { CalendarView } from '@/components/CalendarView';

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const ctx = await requireWorkspace();
  // Staff manage everyone's calendar; a doctor manages their own. The server
  // route enforces which rows either can touch — this only decides whether the
  // grid is draggable at all.
  const canManage =
    hasPermission(ctx.role, 'call:write') || hasPermission(ctx.role, 'calendar:write_self');
  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle="Every appointment, per doctor. Drag one to move it — the patient is told the new time."
      />
      <CalendarView canManage={canManage} />
    </>
  );
}
