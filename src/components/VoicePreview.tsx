'use client';

import { useRef, useState } from 'react';

// #2: a play button that previews a Gemini Live voice via /api/voices/preview.
// Clips are cached server-side; if synthesis is unavailable (e.g. free-tier
// rate limit) we surface a gentle hint instead of an error.
export function VoicePreview({ voiceId, lang, className }: { voiceId: string; lang?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'unavailable'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function play() {
    if (state === 'loading') return;
    // Toggle off if currently playing.
    if (state === 'playing' && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setState('idle');
      return;
    }
    setState('loading');
    try {
      const res = await fetch(
        `/api/voices/preview?voice=${encodeURIComponent(voiceId)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`,
      );
      if (!res.ok) {
        setState('unavailable');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setState('idle');
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => setState('unavailable');
      await audio.play();
      setState('playing');
    } catch {
      setState('unavailable');
    }
  }

  return (
    <button
      type="button"
      onClick={play}
      title={state === 'unavailable' ? 'Preview unavailable — you’ll hear it on a test call' : 'Preview voice'}
      className={
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 ' +
        'text-sm text-accent transition hover:bg-border hover:text-ink disabled:opacity-50 ' +
        (className ?? '')
      }
      aria-label="Preview voice"
    >
      {state === 'loading' ? '…' : state === 'playing' ? '⏸' : state === 'unavailable' ? '🔇' : '▶'}
    </button>
  );
}
