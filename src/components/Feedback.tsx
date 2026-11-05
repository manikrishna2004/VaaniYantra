'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// App-wide, non-blocking feedback: toast notifications + a promise-based
// confirm dialog. Replaces native window.alert/confirm so messaging matches
// the product's look and never freezes the main thread.

type ToastType = 'success' | 'error' | 'info';
type ToastItem = { id: number; message: string; type: ToastType };

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * When set, the user must type this string exactly before Confirm enables.
   * For operations where "are you sure?" is not enough because the cost of
   * getting the WRONG row is unrecoverable — you have to know, and type, what
   * you are destroying.
   */
  requireText?: string;
  /** Label above that input, e.g. "Type the organisation name to confirm". */
  requireTextLabel?: string;
  /**
   * Collect a free-text note alongside the confirmation. Delivered via a
   * callback rather than the promise so `confirm()` keeps returning a plain
   * boolean for the callers that do not need one.
   */
  note?: {
    label: string;
    placeholder?: string;
    defaultValue?: string;
    onConfirm: (note: string) => void;
  };
};

type FeedbackCtx = {
  toast: (message: string, type?: ToastType) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
};

const Ctx = createContext<FeedbackCtx | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within <FeedbackProvider>');
  return ctx.toast;
}

export function useConfirm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConfirm must be used within <FeedbackProvider>');
  return ctx.confirm;
}

type PendingDialog = ConfirmOptions & { resolve: (v: boolean) => void };

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const idRef = useRef(0);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })),
    [],
  );

  const closeDialog = useCallback(
    (result: boolean) => {
      setDialog((d) => {
        if (result) d?.note?.onConfirm(note.trim());
        d?.resolve(result);
        return null;
      });
      // Reset both, or the next dialog opens pre-satisfied with the previous
      // one's text still in the box.
      setTyped('');
      setNote('');
    },
    [note],
  );

  // Escape cancels the dialog.
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, closeDialog]);

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}

      {/* Toast stack */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-md animate-in',
              t.type === 'success' && 'border-success/30 bg-success/10 text-ink',
              t.type === 'error' && 'border-danger/30 bg-danger/10 text-ink',
              t.type === 'info' && 'border-border bg-surface text-ink',
            )}
            role="status"
          >
            <span className="mt-0.5 text-base leading-none">
              {t.type === 'success' ? '✓' : t.type === 'error' ? '⚠' : 'ℹ'}
            </span>
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => setToasts((arr) => arr.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
              className="text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Confirm dialog */}
      {dialog && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => closeDialog(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            className="card relative w-full max-w-md p-6 shadow-xl animate-in"
          >
            <h2 className="text-base font-semibold text-ink">{dialog.title}</h2>
            {dialog.message && <p className="mt-2 text-sm text-muted">{dialog.message}</p>}
            {dialog.note && (
              <div className="mt-4">
                <label className="label">{dialog.note.label}</label>
                <input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={dialog.note.placeholder}
                  className="input w-full text-sm"
                />
              </div>
            )}
            {dialog.requireText && (
              <div className="mt-4">
                <label className="label">
                  {dialog.requireTextLabel || 'Type to confirm'}
                </label>
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={dialog.requireText}
                  className="input w-full font-mono text-sm"
                />
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => closeDialog(false)}
                className="rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition hover:border-primary/60"
              >
                {dialog.cancelLabel || 'Cancel'}
              </button>
              <button
                autoFocus={!dialog.requireText && !dialog.note}
                disabled={Boolean(dialog.requireText) && typed !== dialog.requireText}
                onClick={() => closeDialog(true)}
                className={cn(
                  'rounded-xl px-4 py-2.5 text-sm font-medium text-white transition',
                  dialog.danger ? 'bg-danger hover:bg-danger/90' : 'bg-primary hover:bg-primary-hover',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {dialog.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
