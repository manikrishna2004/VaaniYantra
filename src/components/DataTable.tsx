import Link from 'next/link';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui';
import type { LucideIcon } from 'lucide-react';

// One table for every list surface. Calls, reports, invoices and the admin
// screens each hand-rolled their own <table>, which is where inconsistency
// creeps in fastest — and each repeated the same three mistakes:
//
//   * no <caption> and no scope="col", so assistive tech cannot tie a cell to
//     its column heading;
//   * a row-wide hover state, but only the one or two cells that happened to
//     wrap a <Link> were actually clickable — the row looked navigable and
//     mostly wasn't;
//   * no horizontal scroll container, so a wide table pushed the whole page
//     sideways on a phone.
//
// Row navigation uses the stretched-link pattern: a single real link in the
// first cell, expanded over the row with an ::after overlay. One focusable
// element per row, the entire row clickable, and no nested interactive
// elements for a screen reader to trip over.

export type Column<T> = {
  /** Column heading. Rendered in a <th scope="col">. */
  header: string;
  /** Cell contents for a row. */
  cell: (row: T) => React.ReactNode;
  /** Right-align and use tabular figures — for durations, counts, money. */
  numeric?: boolean;
  /** Hide below the sm breakpoint, for columns that aren't worth the width. */
  hideOnMobile?: boolean;
  className?: string;
};

export type DataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Describes the table for screen readers; visually hidden. */
  caption: string;
  /** When set, the whole row navigates here. */
  rowHref?: (row: T) => string;
  empty?: { title: string; description?: string; icon?: LucideIcon; action?: React.ReactNode };
  className?: string;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  rowHref,
  empty,
  className,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
    return <EmptyState title={empty.title} description={empty.description} icon={empty.icon} action={empty.action} />;
  }

  return (
    // The scroll container is part of the component so no caller can forget it
    // and let a wide table scroll the page body sideways.
    <div className={cn('card overflow-hidden', className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-left">
              {columns.map((c) => (
                <th
                  key={c.header}
                  scope="col"
                  className={cn(
                    'eyebrow whitespace-nowrap px-5 py-3 font-semibold',
                    c.numeric && 'text-right',
                    c.hideOnMobile && 'hidden sm:table-cell',
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const href = rowHref?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  className={cn(
                    'border-b border-border/60 transition-colors duration-fast last:border-0',
                    href && 'relative cursor-pointer hover:bg-surface-2 focus-within:bg-surface-2',
                  )}
                >
                  {columns.map((c, i) => (
                    <td
                      key={c.header}
                      className={cn(
                        'px-5 py-3 align-middle',
                        c.numeric && 'text-right tabular-nums',
                        c.hideOnMobile && 'hidden sm:table-cell',
                        c.className,
                      )}
                    >
                      {/* The stretched link lives in the first cell only. */}
                      {i === 0 && href ? (
                        <Link
                          href={href}
                          className="rounded outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-primary/60"
                        >
                          {c.cell(row)}
                        </Link>
                      ) : (
                        c.cell(row)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
