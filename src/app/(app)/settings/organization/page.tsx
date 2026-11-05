import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { OrgSettings } from '@/components/OrgSettings';

export const dynamic = 'force-dynamic';

export default async function OrganizationSettingsPage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'org:manage')) notFound();
  const org = await prisma.organization.findUnique({
    where: { id: ctx.org.id },
    select: { name: true, slug: true, brandColor: true, dataRetentionDays: true, uhidPrefix: true },
  });
  const memberCount = await prisma.membership.count({ where: { orgId: ctx.org.id } });

  return (
    <OrgSettings
      name={org?.name ?? ''}
      slug={org?.slug ?? ''}
      brandColor={org?.brandColor ?? null}
      dataRetentionDays={org?.dataRetentionDays ?? null}
      uhidPrefix={org?.uhidPrefix ?? null}
      memberCount={memberCount}
      canManage={hasPermission(ctx.role, 'member:manage')}
    />
  );
}
