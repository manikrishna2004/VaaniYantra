'use client';

// A lightweight dependency-free bar chart for daily call volume.
export function CallVolumeChart({ data }: { data: { date: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex h-40 items-stretch gap-1.5">
      {data.map((d) => {
        const h = Math.round((d.count / max) * 100);
        return (
          <div key={d.date} className="group relative flex flex-1 flex-col items-center justify-end">
            <div
              className="w-full rounded-t bg-primary/70 transition-all group-hover:bg-primary"
              style={{ height: `${Math.max(h, d.count > 0 ? 6 : 2)}%` }}
            />
            <div className="pointer-events-none absolute -top-7 hidden rounded-md bg-surface-2 px-2 py-1 text-[11px] text-ink group-hover:block">
              {d.count} · {d.date.slice(5)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
