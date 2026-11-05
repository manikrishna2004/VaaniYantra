import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PageHeader } from '@/components/ui';
import { PatientsManager } from '@/components/PatientsManager';

export const dynamic = 'force-dynamic';

export default async function PatientsPage() {
  const ctx = await requireWorkspace();
  // Medical records sit behind their own permission, so a read-only seat gets
  // the same 404 it would get for a page that isn't theirs rather than an empty
  // table backed by a 403.
  if (!hasPermission(ctx.role, 'patient:read')) notFound();
  return (
    <>
      <PageHeader
        title="Patients"
        subtitle="Everyone your agents have booked, plus the prescriptions and notes you file after each consultation. Each patient gets your chatbot link with their appointment confirmation, and signs in there with their mobile number and a code."
      />
      <PatientsManager canManage={hasPermission(ctx.role, 'patient:write')} />
    </>
  );
}
