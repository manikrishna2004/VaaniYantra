import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { getPatientProvider } from '@/lib/patients';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Staff view of an attachment. Same decryption path as the patient's download,
// scoped to the org and to a document that really hangs off this patient.
export async function GET(_req: Request, props: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:read');
  if (denied) return denied;

  const owned = await prisma.visitDocument.findFirst({
    where: { id: docId, orgId: ctx.org.id, visit: { contactId: id, workspaceId: ctx.workspace.id } },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const provider = await getPatientProvider(ctx.org.id);
  const doc = await provider.readDocument(docId, { orgId: ctx.org.id });
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return new NextResponse(new Uint8Array(doc.buffer), {
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename="${doc.name.replace(/[^\w.\- ]+/g, '_')}"`,
      'Content-Length': String(doc.buffer.length),
      'Cache-Control': 'private, no-store',
    },
  });
}
