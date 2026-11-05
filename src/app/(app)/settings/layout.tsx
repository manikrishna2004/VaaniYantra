import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { SettingsNav } from '@/components/SettingsNav';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireWorkspace();
  const items = [
    // Account is everyone's — it is their own name, email and password.
    { href: '/settings', label: 'Account' },
    // The practice itself and what it pays are the owner's. These two were the
    // only tabs here with no permission filter at all, so a doctor could read
    // the clinic's plan, invoices and GST details.
    ...(hasPermission(ctx.role, 'org:manage')
      ? [{ href: '/settings/organization', label: 'Organization' }]
      : []),
    ...(hasPermission(ctx.role, 'billing:manage')
      ? [{ href: '/settings/billing', label: 'Billing' }]
      : []),
    ...(hasPermission(ctx.role, 'apikey:read')
      ? [{ href: '/settings/api-keys', label: 'API Keys' }]
      : []),
    ...(hasPermission(ctx.role, 'integration:read')
      ? [{ href: '/settings/webhooks', label: 'Webhooks' }]
      : []),
    ...(hasPermission(ctx.role, 'audit:read')
      ? [{ href: '/settings/audit', label: 'Audit Log' }]
      : []),
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Settings</h1>
      <SettingsNav items={items} />
      <div className="max-w-3xl">{children}</div>
    </div>
  );
}
