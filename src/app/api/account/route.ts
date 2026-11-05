import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Update the signed-in user's profile (display name). Email/password are managed
// by Firebase on the client.
export async function PATCH(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim();
  if (name === undefined) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  const user = await prisma.user.update({
    where: { id: ctx.user.id },
    data: { name: name || null },
  });
  return NextResponse.json({ ok: true, name: user.name });
}
