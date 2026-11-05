import { prisma } from '@/lib/db';
import { embedBatch } from './embeddings';

// Split text into overlapping chunks sized for retrieval. Paragraph-aware:
// accumulate paragraphs until the target size, then start a new chunk with a
// small overlap so context isn't lost at boundaries.
export function chunkText(text: string, targetChars = 900, overlapChars = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const para of paras) {
    if ((current + '\n\n' + para).length > targetChars && current) {
      chunks.push(current.trim());
      const tail = current.slice(-overlapChars);
      current = tail + '\n\n' + para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Hard-split any oversized chunk (e.g. a single huge paragraph).
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= targetChars * 1.5) {
      out.push(c);
    } else {
      for (let i = 0; i < c.length; i += targetChars) {
        out.push(c.slice(i, i + targetChars));
      }
    }
  }
  return out;
}

// Extract plain text from an uploaded file buffer. Handles PDF and DOCX via
// dedicated parsers (dynamically imported so the heavy deps load only when
// needed and stay out of the route bundle), plus text-like formats directly.
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const lower = filename.toLowerCase();

  // PDF — pdf-parse v2 (pdfjs under the hood).
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    return extractPdf(buffer);
  }

  // DOCX — mammoth (raw text, ignoring styling).
  if (
    mimeType.includes('officedocument.wordprocessingml') ||
    mimeType === 'application/msword' ||
    lower.endsWith('.docx')
  ) {
    return extractDocx(buffer);
  }

  const isTextLike =
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    /\.(txt|md|csv|json|html?|xml|ya?ml)$/i.test(filename);
  if (isTextLike) return buffer.toString('utf8');

  // Best-effort: many simple files are still readable as UTF-8.
  const asText = buffer.toString('utf8');
  // Strip control bytes that signal a binary format we can't parse here.
  const printableRatio =
    asText.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').length / Math.max(asText.length, 1);
  if (printableRatio > 0.8) return asText;
  return `[Unsupported file type "${mimeType}". Add a parser for this format to extract its text.]`;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    // pdf-parse appends "-- N of M --" page-separator footers; strip them so
    // they don't pollute chunks/embeddings.
    return (result.text ?? '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return value ?? '';
}

// Embed pre-split chunks -> persist -> mark READY. The caller controls chunk
// boundaries (e.g. one chunk per FAQ pair). Marks the Document FAILED on error.
export async function ingestChunks(
  documentId: string,
  chunks: string[],
  rawText: string,
  // Optional per-agent Gemini key: when a document is uploaded for an agent
  // that brings its own key, embed with that key rather than the platform's.
  apiKey?: string,
): Promise<void> {
  try {
    const embeddings = await embedBatch(chunks, apiKey);

    await prisma.$transaction([
      prisma.documentChunk.deleteMany({ where: { documentId } }),
      ...chunks.map((content, index) =>
        prisma.documentChunk.create({
          // Embedding stored as a JSON-encoded number[].
          data: { documentId, index, content, embedding: JSON.stringify(embeddings[index]) },
        }),
      ),
      prisma.document.update({
        where: { id: documentId },
        data: { rawText: rawText.slice(0, 100_000), status: 'READY' },
      }),
    ]);
  } catch (err) {
    console.error('[rag] ingestChunks failed', err);
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'FAILED' },
    });
  }
}

// Chunk -> embed -> persist already-extracted text, then mark READY. Shared by
// file uploads and URL crawls. Marks the Document FAILED on error.
export async function ingestText(documentId: string, text: string): Promise<void> {
  await ingestChunks(documentId, chunkText(text), text);
}

// Process an uploaded file Document: extract -> ingest. Marks FAILED on a parse
// error before any text is available.
export async function ingestDocument(
  documentId: string,
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<void> {
  let text: string;
  try {
    text = await extractText(buffer, mimeType, filename);
  } catch (err) {
    console.error('[rag] extract failed', err);
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'FAILED' },
    });
    return;
  }
  await ingestText(documentId, text);
}
