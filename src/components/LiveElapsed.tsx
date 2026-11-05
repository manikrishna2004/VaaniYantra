'use client';

import { useEffect, useState } from 'react';

// Ticking elapsed-time display (mm:ss) since a given start instant.
export function LiveElapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!since) return <>0:00</>;
  const sec = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return (
    <>
      {m}:{String(s).padStart(2, '0')}
    </>
  );
}
