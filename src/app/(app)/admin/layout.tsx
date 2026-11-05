import { redirect } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { isSuperAdmin } from '@/lib/platform';

export const dynamic = 'force-dynamic';

// Founder-only area. Gated by SUPERADMIN_EMAILS; everyone else is bounced.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireWorkspace();
  if (!isSuperAdmin(ctx.user.email)) redirect('/dashboard');
  return <>{children}</>;
}
