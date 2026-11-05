import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { isSuperAdmin } from '@/lib/platform';
import { AdminDashboard } from '@/components/AdminDashboard';

export const dynamic = 'force-dynamic';

// The founder's platform console. Every /api/admin/* route already checks
// isSuperAdmin, so this page could not leak data — but without a check here it
// still RENDERED for any signed-in customer, exposing the shape of the console
// (plan keys, config field names, promo tooling) and looking alarmingly like a
// privilege escalation to anyone who found it. Hiding the sidebar link hides it
// from view, not from a typed URL.
//
// notFound() rather than a 403: a non-admin has no business learning that this
// route exists at all.
export default async function AdminPage() {
  const ctx = await requireWorkspace();
  if (!isSuperAdmin(ctx.user.email)) notFound();
  return <AdminDashboard />;
}
