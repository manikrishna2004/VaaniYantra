import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { ingestText } from '@/lib/rag/ingest';
import { fetchUrlText, UrlIngestError } from '@/lib/rag/web';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, props: Params) {
  const params = await props.params;
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:read')) {
    return NextResponse.json({ error: 'You do not have access to the knowledge base.' }, { status: 403 });
  }
  const doc = await prisma.document.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: {
      chunks: { orderBy: { index: 'asc' }, select: { index: true, content: true } },
      knowledgeLinks: { include: { agent: { select: { id: true, name: true } } } },
    },
  });
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(doc);
}

// Re-crawl a URL document: re-fetch its source page and re-ingest.
export async function POST(_req: Request, props: Params) {
  const params = await props.params;
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:write')) {
    return NextResponse.json({ error: 'You do not have permission to change the knowledge base.' }, { status: 403 });
  }
  const doc = await prisma.document.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
  });
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (doc.sourceType !== 'URL' || !doc.sourceUrl) {
    return NextResponse.json({ error: 'Only URL documents can be re-crawled' }, { status: 400 });
  }

  let page: { title: string; text: string; finalUrl: string };
  try {
    page = await fetchUrlText(doc.sourceUrl);
  } catch (err) {
    const msg = err instanceof UrlIngestError ? err.message : 'Could not re-crawl that URL.';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  if (!page.text || page.text.length < 20) {
    return NextResponse.json({ error: 'No readable text found at that URL.' }, { status: 400 });
  }

  await prisma.document.update({
    where: { id: doc.id },
    data: {
      status: 'PROCESSING',
      name: page.title.slice(0, 200),
      sourceUrl: page.finalUrl,
      sizeBytes: Buffer.byteLength(page.text, 'utf8'),
    },
  });
  await ingestText(doc.id, page.text);

  const updated = await prisma.document.findUnique({
    where: { id: doc.id },
    include: { _count: { select: { chunks: true } } },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, props: Params) {
  const params = await props.params;
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:write')) {
    return NextResponse.json({ error: 'You do not have permission to change the knowledge base.' }, { status: 403 });
  }
  const existing = await prisma.document.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.document.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
