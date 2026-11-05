import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { isPlanKey } from '@/lib/billing/catalogue';
import { normalizeCode, MIN_CHARGE_INR } from '@/lib/billing/promo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Promo codes (super-admin). List, create, and deactivate.

export async function GET() {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const codes = await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  return NextResponse.json({ codes });
}

export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    code?: string;
    description?: string;
    percentOff?: number | string;
    fixedPriceInr?: number | string;
    plans?: string;
    maxRedemptions?: number | string;
    expiresInDays?: number | string;
  };

  const code = normalizeCode(body.code ?? '');
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    return NextResponse.json(
      { error: 'Code must be 3–32 characters: letters, digits, hyphen or underscore.' },
      { status: 400 },
    );
  }

  const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
  const percentOff = num(body.percentOff);
  const fixedPriceInr = num(body.fixedPriceInr);

  // Exactly one discount shape, or the code has no defined meaning.
  if ((percentOff == null) === (fixedPriceInr == null)) {
    return NextResponse.json(
      { error: 'Set either a percentage off or a fixed price — not both, not neither.' },
      { status: 400 },
    );
  }
  if (percentOff != null && (!Number.isFinite(percentOff) || percentOff < 1 || percentOff > 100)) {
    return NextResponse.json({ error: 'Percentage off must be between 1 and 100.' }, { status: 400 });
  }
  if (fixedPriceInr != null && (!Number.isFinite(fixedPriceInr) || fixedPriceInr < MIN_CHARGE_INR)) {
    return NextResponse.json({ error: `Fixed price must be at least ₹${MIN_CHARGE_INR}.` }, { status: 400 });
  }

  // Restricting to plans that don't exist would silently make the code unusable.
  let plans: string | null = null;
  if (body.plans?.trim()) {
    const keys = body.plans.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
    const bad = keys.filter((k) => !isPlanKey(k));
    if (bad.length) return NextResponse.json({ error: `Unknown plan(s): ${bad.join(', ')}` }, { status: 400 });
    plans = keys.join(',');
  }

  const maxRedemptions = num(body.maxRedemptions);
  const expiresInDays = num(body.expiresInDays);
  const expiresAt =
    expiresInDays != null && Number.isFinite(expiresInDays) && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const existing = await prisma.promoCode.findUnique({ where: { code } });
  if (existing) return NextResponse.json({ error: `Code ${code} already exists.` }, { status: 409 });

  const promo = await prisma.promoCode.create({
    data: {
      code,
      description: body.description?.trim() || null,
      percentOff: percentOff ?? null,
      fixedPriceInr: fixedPriceInr ?? null,
      plans,
      maxRedemptions: maxRedemptions != null && maxRedemptions > 0 ? Math.floor(maxRedemptions) : null,
      expiresAt,
    },
  });
  await audit(ctx, 'platform.promo_created', {
    targetType: 'PromoCode',
    targetId: promo.id,
    metadata: { code, percentOff, fixedPriceInr, maxRedemptions },
    req,
  });
  return NextResponse.json({ ok: true, promo });
}

// Deactivate rather than delete, so a redeemed code keeps its audit trail.
export async function PATCH(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { code?: string; active?: boolean };
  const code = normalizeCode(body.code ?? '');
  if (!code) return NextResponse.json({ error: 'Code required' }, { status: 400 });

  const updated = await prisma.promoCode.updateMany({
    where: { code },
    data: { active: body.active === true },
  });
  if (!updated.count) return NextResponse.json({ error: 'No such code' }, { status: 404 });

  await audit(ctx, 'platform.promo_toggled', {
    targetType: 'PromoCode',
    metadata: { code, active: body.active === true },
    req,
  });
  return NextResponse.json({ ok: true });
}
