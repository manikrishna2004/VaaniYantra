import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { ingestDocument, ingestText } from '@/lib/rag/ingest';
import { fetchUrlText, UrlIngestError } from '@/lib/rag/web';
import { checkCreateAllowed, limitMessage } from '@/lib/billing/catalogue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:read')) {
    return NextResponse.json({ error: 'You do not have access to the knowledge base.' }, { status: 403 });
  }
  const documents = await prisma.document.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { chunks: true, knowledgeLinks: true } } },
  });
  return NextResponse.json(documents);
}

// Byte caps: ingestion cost and retrieval sharpness, per workspace.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per document
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB across the workspace

// How many documents you may keep is a PLAN limit, not a constant. This used to
// be a hardcoded 5 per workspace while checkCreateAllowed('knowledgeDocs') sat
// unused and the plan's real number was printed in three places in the UI — so
// a Hospital customer was sold 1,000, shown "3 / 1000" on their billing page,
// and refused at document 6. The plan limit is per ORG, which is also why the
// count cannot stay keyed on the workspace.
async function checkDocLimits(
  orgId: string,
  workspaceId: string,
  newBytes: number,
): Promise<string | null> {
  const [gate, agg] = await Promise.all([
    checkCreateAllowed(orgId, 'knowledgeDocs'),
    prisma.document.aggregate({ where: { workspaceId }, _sum: { sizeBytes: true } }),
  ]);
  if (!gate.allowed) return limitMessage('knowledgeDocs', gate.limit, gate.plan);
  if (newBytes > MAX_FILE_BYTES) return 'Each document must be 10 MB or smaller.';
  if ((agg._sum.sizeBytes ?? 0) + newBytes > MAX_TOTAL_BYTES) return 'Your knowledge base is limited to 20 MB in total.';
  return null;
}

// Add a knowledge-base document. Two modes by content-type:
//   • multipart/form-data with `file`  → upload a PDF/DOCX/text file
//   • application/json with `{ url }`   → crawl a public web page
// The source is extracted, chunked, embedded, and stored. Status starts
// PROCESSING and flips to READY (or FAILED).
export async function POST(req: Request) {
  const { workspace, org, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:write')) {
    return NextResponse.json({ error: 'You do not have permission to change the knowledge base.' }, { status: 403 });
  }

  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    return addFromUrl(req, org.id, workspace.id);
  }

  const form = await req.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';

  const limitError = await checkDocLimits(org.id, workspace.id, buffer.length);
  if (limitError) return NextResponse.json({ error: limitError }, { status: 400 });

  const doc = await prisma.document.create({
    data: {
      workspaceId: workspace.id,
      name: file.name,
      mimeType,
      sizeBytes: buffer.length,
      status: 'PROCESSING',
    },
  });

  // Ingest synchronously for the MVP (files are small). For large files, move
  // this to a background job/queue and let the UI poll the PROCESSING status.
  await ingestDocument(doc.id, buffer, mimeType, file.name);

  const updated = await prisma.document.findUnique({
    where: { id: doc.id },
    include: { _count: { select: { chunks: true } } },
  });
  return NextResponse.json(updated, { status: 201 });
}

async function addFromUrl(req: Request, orgId: string, workspaceId: string) {
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  const rawUrl = body.url?.trim() ?? '';
  if (!rawUrl) return NextResponse.json({ error: 'A URL is required' }, { status: 400 });

  let page: { title: string; text: string; finalUrl: string };
  try {
    page = await fetchUrlText(rawUrl);
  } catch (err) {
    const msg = err instanceof UrlIngestError ? err.message : 'Could not ingest that URL.';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  if (!page.text || page.text.length < 20) {
    return NextResponse.json({ error: 'No readable text found at that URL.' }, { status: 400 });
  }

  const limitError = await checkDocLimits(orgId, workspaceId, Buffer.byteLength(page.text, 'utf8'));
  if (limitError) return NextResponse.json({ error: limitError }, { status: 400 });

  const doc = await prisma.document.create({
    data: {
      workspaceId,
      name: page.title.slice(0, 200),
      mimeType: 'text/html',
      sizeBytes: Buffer.byteLength(page.text, 'utf8'),
      status: 'PROCESSING',
      sourceType: 'URL',
      sourceUrl: page.finalUrl,
    },
  });
  await ingestText(doc.id, page.text);

  const updated = await prisma.document.findUnique({
    where: { id: doc.id },
    include: { _count: { select: { chunks: true } } },
  });
  return NextResponse.json(updated, { status: 201 });
}
