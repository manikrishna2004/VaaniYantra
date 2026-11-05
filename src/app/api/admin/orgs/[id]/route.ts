import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { prisma } from '@/lib/db';
import { recordPlanChange } from '@/lib/plan-history';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { isPlanKey } from '@/lib/billing/catalogue';
import { clearPatientProviderCache } from '@/lib/patients';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PATIENT_PROVIDERS = ['native', 'push', 'rest', 'fhir'] as const;
type PatientProvider = (typeof PATIENT_PROVIDERS)[number];

function isPatientProvider(v: unknown): v is PatientProvider {
  return typeof v === 'string' && (PATIENT_PROVIDERS as readonly string[]).includes(v);
}

// Super-admin override of an org's plan and/or its patient-data provider.
// Both fields are optional; send whichever is being changed.
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    plan?: string;
    patientProvider?: string;
    /** Display name of their system ("Practo Ray"), used in staff-facing copy. */
    patientSystemName?: string;
  };

  const changingPlan = body.plan !== undefined;
  const changingProvider = body.patientProvider !== undefined;
  if (!changingPlan && !changingProvider) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  }
  if (changingPlan && !isPlanKey(body.plan)) {
    return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
  }
  if (changingProvider && !isPatientProvider(body.patientProvider)) {
    return NextResponse.json(
      { error: `patientProvider must be one of: ${PATIENT_PROVIDERS.join(', ')}` },
      { status: 400 },
    );
  }

  const org = await prisma.organization.findUnique({
    where: { id: params.id },
    select: { id: true, patientProviderConfig: true },
  });
  if (!org) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const config =
    body.patientSystemName !== undefined
      ? { ...((org.patientProviderConfig as object) ?? {}), systemName: body.patientSystemName.trim() }
      : undefined;

  await prisma.organization.update({
    where: { id: params.id },
    data: {
      ...(changingPlan ? { plan: body.plan as string } : {}),
      ...(changingProvider ? { patientProvider: body.patientProvider as string } : {}),
      ...(config ? { patientProviderConfig: config } : {}),
    },
  });
  if (changingPlan) await recordPlanChange(params.id, body.plan as string, 'admin');
  // The factory caches provider resolution for 30s; drop this org's entry so
  // the switch takes effect on the very next request rather than "soon".
  clearPatientProviderCache(params.id);

  if (changingPlan) {
    await audit(ctx, 'platform.org_plan_changed', {
      targetType: 'Organization',
      targetId: params.id,
      metadata: { plan: body.plan },
      req,
    });
  }
  if (changingProvider) {
    await audit(ctx, 'platform.org_patient_provider_changed', {
      targetType: 'Organization',
      targetId: params.id,
      metadata: { patientProvider: body.patientProvider, systemName: body.patientSystemName },
      req,
    });
  }
  return NextResponse.json({ ok: true, plan: body.plan, patientProvider: body.patientProvider });
}
