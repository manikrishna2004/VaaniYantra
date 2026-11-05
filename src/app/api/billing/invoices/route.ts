import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// This org's invoices, newest first. Scoped to the caller's org — an invoice is
// financial data and must never be reachable by id alone from another tenant.
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;

  // Plan, usage, GSTIN, billing address and invoices are the practice's
  // finances. The write verbs on these routes always checked; the reads never
  // did, so a VIEWER or a DOCTOR could read all of it.
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const invoices = await prisma.invoice.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { issuedAt: 'desc' },
    take: 60,
    select: {
      id: true,
      number: true,
      plan: true,
      description: true,
      periodStart: true,
      periodEnd: true,
      subtotalInr: true,
      discountInr: true,
      taxableInr: true,
      cgstInr: true,
      sgstInr: true,
      igstInr: true,
      totalInr: true,
      taxRate: true,
      promoCode: true,
      paymentMethod: true,
      status: true,
      issuedAt: true,
    },
  });

  return NextResponse.json({ invoices });
}
