'use client';

import { useEffect } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

// Keeps the httpOnly session cookie fresh. Firebase rotates the ID token (~every
// hour and on load); whenever it changes we push the new token to the server so
// the cookie never goes stale while the app is open.
//
// Kept after the move to 14-day session cookies, where it looks redundant. It is
// not: if the service account lacks roles/iam.serviceAccountTokenCreator,
// createSession() degrades to a 1-hour ID-token cookie (see src/lib/auth/session.ts)
// and this is the only thing holding that session open. On the healthy path it
// costs one cheap re-mint per hour per open tab and slides the 14-day window
// forward, which is not worth removing to save.
export function SessionRefresher() {
  useEffect(() => {
    const unsub = onIdTokenChanged(auth, async (user) => {
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
      } catch {
        /* ignore transient refresh errors */
      }
    });
    return () => unsub();
  }, []);
  return null;
}
