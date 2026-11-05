'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { Button } from '@/components/ui';
import { EXPORT_LABELS, EXPORT_TYPES, type ExportType } from '@/lib/reports';
import { cn } from '@/lib/utils';

// Download any of the clinic's records as CSV. This is how data leaves
// VaaniYantra now that the Google Drive export is gone.
//
// `only` narrows the menu to a single record type, in which case it collapses
// to a plain button — an "Export CSV ▾" that opens a one-item menu is just a
// worse button.
export function ExportMenu({
  range = '30',
  only,
  size = 'sm',
  types,
}: {
  range?: string;
  only?: ExportType;
  size?: 'sm' | 'md';
  /**
   * Which record types this viewer may download. Defaults to all of them.
   * The route enforces this per type (patient-bearing exports need
   * `patient:read`); passing it here keeps a read-only seat from being offered
   * a menu item that can only answer 403.
   */
  types?: readonly ExportType[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const href = (type: ExportType) => `/api/reports/export?type=${type}&range=${range}`;
  const available = types ?? EXPORT_TYPES;

  if (only) {
    return (
      <a href={href(only)} download>
        <Button variant="secondary" size={size}>
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </a>
    );
  }

  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" size={size} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <Download className="h-3.5 w-3.5" />
        Export CSV
        <ChevronDown className={cn('h-3.5 w-3.5 transition', open && 'rotate-180')} />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-52 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-xl animate-in"
        >
          {available.map((t) => (
            <a
              key={t}
              role="menuitem"
              href={href(t)}
              download
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-sm text-ink-soft transition hover:bg-surface-2 hover:text-ink"
            >
              {EXPORT_LABELS[t]}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
