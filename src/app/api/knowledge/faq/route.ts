import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { ingestChunks } from '@/lib/rag/ingest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const faqSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(200),
  items: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(1000),
        answer: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1, 'Add at least one question and answer')
    .max(200),
});

function toChunks(items: { question: string; answer: string }[]) {
  const chunks = items.map((it) => `Q: ${it.question}\nA: ${it.answer}`);
  return { chunks, rawText: chunks.join('\n\n') };
}

// Create a new FAQ document.
export async function POST(req: Request) {
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:write')) {
    return NextResponse.json({ error: 'You do not have permission to change the knowledge base.' }, { status: 403 });
  }
  const parsed = faqSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid FAQ' }, { status: 400 });
  }
  const { name, items } = parsed.data;
  const { chunks, rawText } = toChunks(items);

  const doc = await prisma.document.create({
    data: {
      workspaceId: workspace.id,
      name,
      mimeType: 'application/faq',
      sizeBytes: Buffer.byteLength(rawText, 'utf8'),
      status: 'PROCESSING',
      sourceType: 'FAQ',
      faqItems: items,
    },
  });
  await ingestChunks(doc.id, chunks, rawText);

  const updated = await prisma.document.findUnique({
    where: { id: doc.id },
    include: { _count: { select: { chunks: true } } },
  });
  return NextResponse.json(updated, { status: 201 });
}

// Update an existing FAQ document's name/items and re-embed.
export async function PUT(req: Request) {
  const { workspace, role } = await requireWorkspace();
  if (!hasPermission(role, 'knowledge:write')) {
    return NextResponse.json({ error: 'You do not have permission to change the knowledge base.' }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string } & Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const existing = await prisma.document.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (existing.sourceType !== 'FAQ') {
    return NextResponse.json({ error: 'Not a FAQ document' }, { status: 400 });
  }

  const parsed = faqSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid FAQ' }, { status: 400 });
  }
  const { name, items } = parsed.data;
  const { chunks, rawText } = toChunks(items);

  await prisma.document.update({
    where: { id },
    data: {
      name,
      faqItems: items,
      sizeBytes: Buffer.byteLength(rawText, 'utf8'),
      status: 'PROCESSING',
    },
  });
  await ingestChunks(id, chunks, rawText);

  const updated = await prisma.document.findUnique({
    where: { id },
    include: { _count: { select: { chunks: true } } },
  });
  return NextResponse.json(updated);
}
