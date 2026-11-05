import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { BillingManager } from '@/components/BillingManager';

export const dynamic = 'force-dynamic';

// What the practice pays is the owner's business. This page had no check at all,
// so every role could read the plan, the invoices and the GST details.
export default async function BillingSettingsPage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'billing:manage')) notFound();
  return <BillingManager />;
}
