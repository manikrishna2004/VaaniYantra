'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Button, Badge, Spinner, EmptyState, Input } from '@/components/ui';
import { FaqEditor, type FaqItem } from '@/components/FaqEditor';
import { useConfirm } from '@/components/Feedback';
import { formatRelativeTime } from '@/lib/utils';

type Doc = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: 'PROCESSING' | 'READY' | 'FAILED';
  sourceType?: 'FILE' | 'URL' | 'FAQ' | 'TEXT';
  sourceUrl?: string | null;
  createdAt: string;
  _count?: { chunks: number; knowledgeLinks: number };
};

const SOURCE_LABEL: Record<string, string> = {
  FILE: 'File',
  URL: 'Website',
  FAQ: 'FAQ',
  TEXT: 'Text',
};

export function KnowledgeManager() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [addingUrl, setAddingUrl] = useState(false);
  const [recrawling, setRecrawling] = useState<string | null>(null);
  const [faqEditing, setFaqEditing] = useState<
    { id?: string; name: string; items: FaqItem[] } | null
  >(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  async function load() {
    const res = await fetch('/api/knowledge');
    setDocs(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/knowledge', { method: 'POST', body: form });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `Failed to upload ${file.name}`);
        }
      }
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function addUrl() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAddingUrl(true);
    setError(null);
    try {
      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? 'Failed to add URL');
      }
      setUrl('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAddingUrl(false);
    }
  }

  async function recrawl(id: string) {
    setRecrawling(id);
    setError(null);
    try {
      const res = await fetch(`/api/knowledge/${id}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? 'Failed to re-crawl');
      }
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRecrawling(null);
    }
  }

  async function editFaq(id: string) {
    setError(null);
    try {
      const doc = await fetch(`/api/knowledge/${id}`).then((r) => r.json());
      const items: FaqItem[] = Array.isArray(doc.faqItems) ? doc.faqItems : [];
      setFaqEditing({ id, name: doc.name ?? '', items: items.length ? items : [{ question: '', answer: '' }] });
    } catch {
      setError('Could not load that FAQ.');
    }
  }

  async function remove(id: string, name: string) {
    if (
      !(await confirm({
        title: `Delete "${name}"?`,
        message: 'Agents using it will lose this knowledge.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
    setDocs((d) => d.filter((x) => x.id !== id));
  }

  function sizeLabel(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <>
      {faqEditing ? (
        <FaqEditor
          initial={faqEditing}
          onClose={() => setFaqEditing(null)}
          onSaved={() => {
            setFaqEditing(null);
            load();
          }}
        />
      ) : (
        <div className="mb-4 flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFaqEditing({ name: '', items: [{ question: '', answer: '' }] })}
          >
            + Create FAQ
          </Button>
        </div>
      )}
      <Card className="mb-6">
        <div
          className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border px-6 py-10 text-center transition hover:border-primary/50"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            upload(e.dataTransfer.files);
          }}
        >
          <div className="mb-2 text-3xl text-muted">▤</div>
          <p className="text-sm text-ink">Drag & drop files here, or</p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.xml,text/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => upload(e.target.files)}
          />
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <Spinner /> : 'Choose files'}
          </Button>
          <p className="mt-3 text-[11px] text-muted">
            PDF, Word (.docx), and text files (.txt, .md, .csv, .json, .html) are supported.
            Up to <span className="text-ink-soft">5 documents</span>, 10 MB each (20 MB total).
          </p>
          <p className="mt-1 text-[11px] text-muted">
            💡 Keep it focused: upload concise docs about your <span className="text-ink-soft">services,
            pricing, hours, and availability</span> — not long manuals. The agent answers from these.
          </p>
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-sm text-ink">Or add a website</p>
          <div className="flex items-center gap-2">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/help"
              onKeyDown={(e) => {
                if (e.key === 'Enter') addUrl();
              }}
            />
            <Button size="sm" onClick={addUrl} disabled={addingUrl || !url.trim()}>
              {addingUrl ? <Spinner /> : 'Add URL'}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            We fetch the page and extract its readable text. Public pages only.
          </p>
        </div>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Card>

      {loading ? (
        <Card className="flex justify-center py-10">
          <Spinner />
        </Card>
      ) : docs.length === 0 ? (
        <EmptyState title="No documents yet" description="Upload a document to give your agents knowledge." />
      ) : (
        <div className="space-y-3">
          {docs.map((doc) => (
            <Card key={doc.id} className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink">{doc.name}</span>
                  <Badge tone="neutral">{SOURCE_LABEL[doc.sourceType ?? 'FILE'] ?? 'File'}</Badge>
                  <Badge
                    tone={
                      doc.status === 'READY' ? 'success' : doc.status === 'FAILED' ? 'danger' : 'warning'
                    }
                  >
                    {doc.status.toLowerCase()}
                  </Badge>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {sizeLabel(doc.sizeBytes)} · {doc._count?.chunks ?? 0} chunks ·{' '}
                  {doc._count?.knowledgeLinks ?? 0} agents · {formatRelativeTime(doc.createdAt)}
                </div>
                {doc.sourceType === 'URL' && doc.sourceUrl && (
                  <a
                    href={doc.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block truncate text-[11px] text-primary hover:underline"
                  >
                    {doc.sourceUrl}
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                {doc.sourceType === 'FAQ' && (
                  <Button variant="secondary" size="sm" onClick={() => editFaq(doc.id)}>
                    Edit
                  </Button>
                )}
                {doc.sourceType === 'URL' && doc.sourceUrl && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => recrawl(doc.id)}
                    disabled={recrawling === doc.id}
                  >
                    {recrawling === doc.id ? <Spinner /> : 'Re-crawl'}
                  </Button>
                )}
                <Button variant="danger" size="sm" onClick={() => remove(doc.id, doc.name)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
