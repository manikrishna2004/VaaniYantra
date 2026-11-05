'use client';

import { useEffect } from 'react';
import { RefreshCw, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui';

// Error boundary for the dashboard. Without this, a thrown render error showed
// Next's default error screen — unbranded, and offering the user nothing but a
// stack trace they can't act on.
//
// The copy names what happened and what to do about it. It deliberately does
// NOT surface `error.message`: those strings are written for developers and
// routinely leak table and column names.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only safe handle on the server-side stack, so log it
    // where support can correlate it with the server logs.
    console.error('[ui] dashboard error boundary', { digest: error.digest }, error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center text-center">
      <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-danger/10 text-danger ring-1 ring-inset ring-danger/25">
        <RefreshCw className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="h-display text-display-sm font-semibold">This page didn’t load</h1>
      <p className="mt-2 text-sm text-muted">
        Something broke on our side, not yours. Nothing you’ve saved has been lost — trying again usually
        clears it.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </Button>
        <Button variant="secondary" onClick={() => window.history.back()}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Go back
        </Button>
      </div>
      {error.digest && (
        <p className="mt-6 text-xs text-muted">
          Still stuck? Quote this reference: <code className="text-ink-soft">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
