import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin, setPlatformConfig } from '@/lib/platform';
import { TAX_KEYS, getTaxConfig, isValidGstinFormat, stateCodeFromGstin } from '@/lib/billing/tax';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GST settings (super-admin), plus a revenue summary net of what Cashfree keeps.

export async function GET() {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const cfg = await getTaxConfig();
  const agg = await prisma.invoice.aggregate({
    where: { status: 'paid' },
    _sum: { totalInr: true, taxableInr: true, cgstInr: true, sgstInr: true, igstInr: true },
    _count: true,
  });

  const collected = agg._sum.totalInr ?? 0;
  const taxCollected = (agg._sum.cgstInr ?? 0) + (agg._sum.sgstInr ?? 0) + (agg._sum.igstInr ?? 0);
  // Cashfree's cut, so the founder sees true take-home rather than gross. ~2% of
  // the transaction plus 18% GST on that fee. An estimate: the exact rate varies
  // by payment method and is only knowable from settlement reports.
  const GATEWAY_RATE = 0.02;
  const gatewayFee = Math.round(collected * GATEWAY_RATE * 1.18 * 100) / 100;

  return NextResponse.json({
    tax: {
      enabled: cfg.enabled,
      gstin: cfg.gstin ?? '',
      rate: cfg.rate,
      stateCode: cfg.stateCode,
      legalName: cfg.legalName ?? '',
      address: cfg.address ?? '',
    },
    revenue: {
      invoices: agg._count,
      collectedInr: Math.round(collected * 100) / 100,
      taxableInr: Math.round((agg._sum.taxableInr ?? 0) * 100) / 100,
      taxCollectedInr: Math.round(taxCollected * 100) / 100,
      estGatewayFeeInr: gatewayFee,
      estNetInr: Math.round((collected - taxCollected - gatewayFee) * 100) / 100,
    },
  });
}

export async function POST(req: NextRequest) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    gstin?: string;
    rate?: number | string;
    legalName?: string;
    address?: string;
  };

  const gstin = (body.gstin ?? '').trim().toUpperCase();
  if (gstin && !isValidGstinFormat(gstin)) {
    return NextResponse.json(
      { error: 'That GSTIN doesn’t look right — 15 characters, e.g. 37ABCDE1234F1Z5.' },
      { status: 400 },
    );
  }
  // Charging GST without a registration number is not something to let a stray
  // checkbox do.
  if (body.enabled === true && !gstin) {
    return NextResponse.json(
      { error: 'Enter your GSTIN before enabling GST — you cannot legally charge tax without one.' },
      { status: 400 },
    );
  }

  const rate = Number(body.rate);
  const ops: Promise<void>[] = [];
  if (body.gstin !== undefined) ops.push(setPlatformConfig(TAX_KEYS.gstin, gstin, false));
  if (body.enabled !== undefined) ops.push(setPlatformConfig(TAX_KEYS.enabled, body.enabled ? '1' : '0', false));
  if (Number.isFinite(rate) && rate > 0 && rate <= 28) {
    ops.push(setPlatformConfig(TAX_KEYS.rate, String(rate), false));
  }
  if (body.legalName !== undefined) ops.push(setPlatformConfig(TAX_KEYS.legalName, body.legalName.trim(), false));
  if (body.address !== undefined) ops.push(setPlatformConfig(TAX_KEYS.address, body.address.trim(), false));
  // The supplier's own state comes from its GSTIN — it decides intra vs inter.
  const state = stateCodeFromGstin(gstin);
  if (state) ops.push(setPlatformConfig(TAX_KEYS.stateCode, state, false));

  await Promise.all(ops);
  await audit(ctx, 'platform.tax_configured', {
    targetType: 'Platform',
    metadata: { enabled: body.enabled === true, hasGstin: Boolean(gstin) },
    req,
  });
  return NextResponse.json({ ok: true });
}
