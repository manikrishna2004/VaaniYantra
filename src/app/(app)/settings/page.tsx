import { requireWorkspace } from '@/lib/auth/context';
import { AccountSettings } from '@/components/AccountSettings';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const ctx = await requireWorkspace();
  return <AccountSettings name={ctx.user.name} email={ctx.user.email} role={ctx.role} />;
}
