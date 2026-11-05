import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PatientDetail } from '@/components/PatientDetail';

export const dynamic = 'force-dynamic';

export default async function PatientPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await requireWorkspace();
  return (
    <PatientDetail
      patientId={id}
      // Was `call:write`. Identical for all four roles today — MEMBER and up
      // hold both — but this screen writes medical records, not calls, and the
      // gate should say what it means before the two permissions ever diverge.
      canManage={hasPermission(ctx.role, 'patient:write')}
      // Erasing a patient sits with ADMIN, unlike the writes above.
      canDelete={hasPermission(ctx.role, 'patient:delete')}
    />
  );
}
