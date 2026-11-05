'use client';

import { Plus, X } from 'lucide-react';
import { Input, Select } from '@/components/ui';
import { RX_FREQUENCIES, RX_ROUTES } from '@/lib/constants';
import type { RxItemLike } from '@/lib/patients/prescription';

/**
 * The prescription capture grid: one row per medicine.
 *
 * Deliberately NOT part of the parent's `form` object. The parent serialises
 * `form` with a generic `Object.entries(...).forEach(append)` loop, and a nested
 * array does not survive that — it would arrive as "[object Object]". Rows live
 * in their own state and are appended as one JSON key.
 *
 * ⚠ THE TRAP THAT COMES WITH THAT: because rows are outside the form object,
 * `setForm(EMPTY_FORM)` does NOT clear them. Every reset must call `setRows`
 * too, or the previous patient's medicines pre-fill the next consultation —
 * which is a prescribing error with our name on it, not a UI annoyance.
 */

export const EMPTY_RX_ROW: RxItemLike = {
  drug: '',
  strength: '',
  dose: '',
  frequency: '',
  durationDays: null,
  route: '',
  instructions: '',
};

export function PrescriptionRows({
  rows,
  onChange,
  disabled,
}: {
  rows: RxItemLike[];
  onChange: (rows: RxItemLike[]) => void;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<RxItemLike>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    // Never leave the doctor with no way back to the grid.
    onChange(next.length ? next : [{ ...EMPTY_RX_ROW }]);
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="rounded-xl border border-border bg-surface-2 p-3">
          <div className="flex items-start gap-2">
            <span className="mt-2.5 w-4 shrink-0 text-xs tabular-nums text-muted">{i + 1}.</span>
            <div className="grid flex-1 gap-2 sm:grid-cols-[2fr_1fr]">
              <Input
                value={row.drug}
                onChange={(e) => update(i, { drug: e.target.value })}
                placeholder="Medicine name — e.g. Amoxicillin"
                aria-label={`Medicine ${i + 1} name`}
                disabled={disabled}
              />
              <Input
                value={row.strength ?? ''}
                onChange={(e) => update(i, { strength: e.target.value })}
                placeholder="500 mg"
                aria-label={`Medicine ${i + 1} strength`}
                disabled={disabled}
              />
            </div>
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={disabled}
              aria-label={`Remove medicine ${i + 1}`}
              className="mt-1 rounded-lg p-1.5 text-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-4">
            <Input
              value={row.dose ?? ''}
              onChange={(e) => update(i, { dose: e.target.value })}
              placeholder="1 tablet"
              aria-label={`Medicine ${i + 1} dose`}
              disabled={disabled}
            />
            <Select
              value={row.frequency ?? ''}
              onChange={(e) => update(i, { frequency: e.target.value })}
              aria-label={`Medicine ${i + 1} frequency`}
              disabled={disabled}
            >
              <option value="">How often…</option>
              {RX_FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={1}
              max={365}
              value={row.durationDays ?? ''}
              // Empty must become null, not 0 — "for 0 days" is not a duration,
              // and the API would reject it, blocking the whole save.
              onChange={(e) => update(i, { durationDays: e.target.value ? Number(e.target.value) : null })}
              placeholder="Days"
              aria-label={`Medicine ${i + 1} duration in days`}
              disabled={disabled}
            />
            <Select
              value={row.route ?? ''}
              onChange={(e) => update(i, { route: e.target.value })}
              aria-label={`Medicine ${i + 1} route`}
              disabled={disabled}
            >
              <option value="">By mouth (default)</option>
              {RX_ROUTES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="mt-2 pl-6">
            <Input
              value={row.instructions ?? ''}
              onChange={(e) => update(i, { instructions: e.target.value })}
              placeholder="After food, with plenty of water…"
              aria-label={`Medicine ${i + 1} instructions`}
              disabled={disabled}
            />
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...rows, { ...EMPTY_RX_ROW }])}
        disabled={disabled}
        className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-3 py-1.5 text-xs text-ink transition hover:border-primary/60 disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" />
        Add medicine
      </button>
    </div>
  );
}

/** True when the doctor has not actually written a medicine. */
export function rxRowsEmpty(rows: RxItemLike[]): boolean {
  return rows.every((r) => !r.drug.trim());
}
