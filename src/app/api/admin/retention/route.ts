import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { bearerFrom } from '@/lib/cron-auth';
import {
  tickRetention,
  retentionCronSecretMatches,
  lastSweepAt,
  AUDIT_RETENTION_DAYS,
} from '@/lib/retention';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Data-retention sweep. Two callers, exactly like the overage sweep next door:
//  - the founder, from the admin dashboard (super-admin session), or
//  - the VM cron (scripts/retention-sweep.sh) with
//    `Authorization: Bearer $RETENTION_CRON_SECRET`.
//
// Why this route exists at all: the sweeper was previously *only* a 6h
// setInterval inside the voice-server process. If that process was down, every
// org's retention window silently stopped being enforced and nothing reported
// it. The in-process tick is still there — `tickRetention()` guards re-entry
// with its own flag, so running both is safe — but retention no longer depends
// on one long-lived process staying up.

async function authorize(req: Request) {
  if (retentionCronSecretMatches(bearerFrom(req))) return { viaCron: true, ctx: null } as const;

  const { ctx, error } = await apiContext();
  if (error) return { viaCron: false, ctx: null, error } as const;
  if (!isSuperAdmin(ctx.user.email)) {
    return {
      viaCron: false,
      ctx: null,
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as const;
  }
  return { viaCron: false, ctx } as const;
}

export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await authorize(req);
  if ('error' in auth && auth.error) return auth.error;

  const result = await tickRetention();

  if (auth.ctx) {
    await audit(auth.ctx, 'platform.retention_sweep', {
      targetType: 'Platform',
      metadata: { ...result },
      req,
    });
  } else {
    console.log('[retention-sweep] cron run', result);
  }

  return NextResponse.json(result);
}

// Liveness, for scripts/check-retention-freshness.sh. Reports when the last
// sweep actually completed so a silently-dead sweeper is alertable rather than
// invisible.
export async function GET(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await authorize(req);
  if ('error' in auth && auth.error) return auth.error;

  const last = await lastSweepAt();
  const ageHours = last ? (Date.now() - new Date(last).getTime()) / 3_600_000 : null;

  return NextResponse.json({
    lastSweepAt: last,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    auditRetentionDays: AUDIT_RETENTION_DAYS,
  });
}
