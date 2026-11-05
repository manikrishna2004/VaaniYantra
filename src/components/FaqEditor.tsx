'use client';

import { useState } from 'react';
import { Card, Button, Input, Textarea, Field, Spinner } from '@/components/ui';

export type FaqItem = { question: string; answer: string };

export function FaqEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: { id?: string; name: string; items: FaqItem[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [items, setItems] = useState<FaqItem[]>(
    initial?.items?.length ? initial.items : [{ question: '', answer: '' }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = initial?.id;

  function patch(i: number, p: Partial<FaqItem>) {
    setItems((list) => list.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  function addRow() {
    setItems((list) => [...list, { question: '', answer: '' }]);
  }
  function removeRow(i: number) {
    setItems((list) => (list.length === 1 ? list : list.filter((_, idx) => idx !== i)));
  }

  async function save() {
    const cleaned = items
      .map((it) => ({ question: it.question.trim(), answer: it.answer.trim() }))
      .filter((it) => it.question && it.answer);
    if (!name.trim()) return setError('Give this FAQ a name.');
    if (cleaned.length === 0) return setError('Add at least one question and answer.');

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/knowledge/faq', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: name.trim(), items: cleaned }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? 'Failed to save FAQ');
      }
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6 space-y-4 border-primary/40">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">{id ? 'Edit FAQ' : 'New FAQ'}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Billing FAQ" />
      </Field>

      <div className="space-y-4">
        {items.map((it, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Q&amp;A {i + 1}</span>
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-xs text-danger hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
            <Input
              value={it.question}
              onChange={(e) => patch(i, { question: e.target.value })}
              placeholder="Question — e.g. What are your hours?"
            />
            <Textarea
              value={it.answer}
              onChange={(e) => patch(i, { answer: e.target.value })}
              placeholder="Answer the agent should give"
              rows={2}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="secondary" size="sm" onClick={addRow}>
          + Add Q&amp;A
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Spinner /> : id ? 'Save changes' : 'Create FAQ'}
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}
