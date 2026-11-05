'use client';

import { cn } from '@/lib/utils';
import { forwardRef, useEffect } from 'react';
import { Inbox, X, type LucideIcon } from 'lucide-react';

// A small, self-contained UI kit shared across pages.

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="h-display text-2xl font-semibold sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// An in-page switch between views of the same page (not navigation — use
// SettingsNav for that). Rendered as a real tablist so screen readers announce
// it as one control rather than a row of unrelated buttons.
export function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('inline-flex gap-1 rounded-xl border border-border bg-surface-2 p-1', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm transition',
              active ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
            {o.count != null && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                  active ? 'bg-primary-soft text-primary' : 'bg-surface text-muted',
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium',
        'transition-colors duration-fast ease-standard',
        // Keyboard focus was previously invisible on buttons — only inputs had a
        // ring — so tabbing through a page left no trace of where you were.
        'outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        // Presses register physically without moving surrounding layout.
        'active:scale-[0.98] motion-reduce:active:scale-100 motion-reduce:transition-none',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        // min-h keeps the small size a usable touch target rather than the ~26px
        // it collapsed to from padding alone.
        size === 'sm' ? 'min-h-[34px] px-3 py-1.5 text-xs' : 'min-h-[42px] px-4 py-2.5 text-sm',
        // on-primary rather than white: white on coral is 2.81:1 and fails AA.
        variant === 'primary' && 'bg-primary text-on-primary hover:bg-primary-hover',
        variant === 'secondary' && 'bg-surface-2 text-ink border border-border-strong hover:border-primary/60 hover:bg-surface',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25',
        className,
      )}
      {...props}
    />
  );
});

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('card p-5', className)}>{children}</div>;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'primary' | 'accent';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-surface-2 text-muted',
        tone === 'success' && 'bg-success/15 text-success',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'primary' && 'bg-primary/15 text-primary',
        tone === 'accent' && 'bg-accent/15 text-accent',
      )}
    >
      {children}
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn('input', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn('input min-h-[120px] resize-y leading-relaxed', className)} {...props} />;
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn('input cursor-pointer', className)} {...props}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/**
 * A modal dialog for a short form. (The one-question confirm lives in
 * Feedback.tsx's useConfirm — this is for anything with fields in it.)
 *
 * Escape closes and the backdrop closes, because a dialog you can only leave by
 * finding the right button is a trap. Body scroll is locked while open so the
 * page behind doesn't drift under the overlay.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card relative my-8 w-full max-w-lg p-6 shadow-xl animate-in"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="h-display text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="h-display text-lg font-semibold">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * Skeleton placeholder. Preferred over a spinner for content that has a known
 * shape: it holds the layout so nothing jumps when data lands, and it reads as
 * progress rather than as a stall.
 *
 * The sheen is a child element rather than a background-position animation so
 * it composites on the GPU; it is dropped entirely under reduced-motion.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('relative block overflow-hidden rounded-lg bg-surface-2', className)}
    >
      <span className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent motion-reduce:hidden" />
    </span>
  );
}

/**
 * Page-level loading shape: a header block plus rows of cards. Used by route
 * `loading.tsx` files so a navigation paints structure immediately instead of
 * an empty screen while the server renders.
 */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="animate-in" role="status" aria-label="Loading">
      <div className="mb-8 space-y-2.5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current',
        className,
      )}
    />
  );
}
