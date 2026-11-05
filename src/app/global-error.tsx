'use client';

import { useEffect } from 'react';

// Last-resort boundary: catches failures in the root layout itself, where the
// normal error.tsx never gets a chance to mount. It replaces the whole document,
// so it must render its own <html>/<body> and cannot rely on the app's CSS being
// applied — hence the inline styles, which mirror the Midnight palette.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ui] global error boundary', { digest: error.digest }, error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#f4f6fa',
          color: '#101828',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '1.5rem',
        }}
      >
        <main style={{ maxWidth: '26rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
            VaaniYantra is temporarily unavailable
          </h1>
          <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#5d6b7d', lineHeight: 1.6 }}>
            We hit an unexpected error while loading the app. Your data is safe. Please try again in a
            moment.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.7rem 1.15rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              color: '#ffffff',
              background: '#4b3fce',
              border: 'none',
              borderRadius: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', color: '#5d6b7d' }}>
              Reference: <code style={{ color: '#3d4b5c' }}>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
