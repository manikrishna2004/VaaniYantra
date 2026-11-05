import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { GST_STATES } from '@/lib/billing/tax';
import { COUNTRIES } from '@/lib/countries';
import {
  normalizeBillingAddress,
  validateBillingAddress,
  DEFAULT_COUNTRY,
  type BillingAddressInput,
} from '@/lib/billing-address';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The org's billing identity — what appears in the "billed to" block of a tax
// invoice, and what determines place of supply. OWNER only.

export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;

  // Plan, usage, GSTIN, billing address and invoices are the practice's
  // finances. The write verbs on these routes always checked; the reads never
  // did, so a VIEWER or a DOCTOR could read all of it.
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const org = await prisma.organization.findUnique({
    where: { id: ctx.org.id },
    select: {
      name: true,
      gstin: true,
      gstStateCode: true,
      billingName: true,
      billingAddress: true,
      billingLine1: true,
      billingLine2: true,
      billingCity: true,
      billingPostalCode: true,
      billingCountry: true,
      billingRegion: true,
      billingPhone: true,
      billingEmail: true,
    },
  });

  return NextResponse.json({
    billingName: org?.billingName ?? '',
    billingAddress: org?.billingAddress ?? '',
    billingLine1: org?.billingLine1 ?? '',
    billingLine2: org?.billingLine2 ?? '',
    billingCity: org?.billingCity ?? '',
    billingPostalCode: org?.billingPostalCode ?? '',
    billingCountry: org?.billingCountry ?? DEFAULT_COUNTRY,
    billingRegion: org?.billingRegion ?? '',
    billingPhone: org?.billingPhone ?? '',
    billingEmail: org?.billingEmail ?? ctx.user.email,
    gstin: org?.gstin ?? '',
    gstStateCode: org?.gstStateCode ?? '',
    orgName: org?.name ?? '',
    countries: COUNTRIES,
    states: GST_STATES,
    canManage: ctx.role === 'OWNER',
  });
}

export async function PUT(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as BillingAddressInput & { strict?: boolean };

  // Checkout sends strict:true — it can't charge anyone against half an address.
  // The settings card saves whatever has been filled in so far.
  const details = normalizeBillingAddress(body);
  const errors = validateBillingAddress(details, { strict: body.strict === true });
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: Object.values(errors)[0], errors }, { status: 400 });
  }

  await prisma.organization.update({
    where: { id: ctx.org.id },
    data: details,
  });
  await audit(ctx, 'billing.details_updated', {
    targetType: 'Organization',
    targetId: ctx.org.id,
    metadata: { hasGstin: Boolean(details.gstin), state: details.gstStateCode },
    req,
  });

  return NextResponse.json({ ok: true });
}
