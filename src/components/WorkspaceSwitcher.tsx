'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

type Workspace = { id: string; name: string };
type Org = { id: string; name: string; role: string; workspaces: Workspace[] };
type Data = { orgs: Org[]; activeOrgId: string; activeWorkspaceId: string };

export function WorkspaceSwitcher({
  initialOrgName,
  initialWorkspaceName,
}: {
  initialOrgName: string;
  initialWorkspaceName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || data) return;
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [open, data]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function switchTo(workspaceId: string) {
    if (workspaceId === data?.activeWorkspaceId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    await fetch('/api/context/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    setOpen(false);
    setBusy(false);
    router.refresh();
  }

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    setBusy(false);
    if (res.ok) {
      setNewName('');
      setCreating(false);
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition hover:bg-surface-2"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{initialOrgName}</div>
          <div className="truncate text-[11px] text-muted">{initialWorkspaceName} workspace</div>
        </div>
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-auto rounded-xl border border-border bg-surface-2 p-1.5 shadow-xl">
          {!data && <div className="px-3 py-2 text-xs text-muted">Loading…</div>}
          {data?.orgs.map((org) => (
            <div key={org.id} className="mb-1">
              <div className="flex items-center justify-between px-2.5 py-1">
                <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">
                  {org.name}
                </span>
                <span className="text-[10px] text-muted">{org.role.toLowerCase()}</span>
              </div>
              {org.workspaces.map((w) => {
                const active = w.id === data.activeWorkspaceId;
                return (
                  <button
                    key={w.id}
                    disabled={busy}
                    onClick={() => switchTo(w.id)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition',
                      active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface hover:text-ink',
                    )}
                  >
                    <span className="truncate">{w.name}</span>
                    {active && <span className="text-xs">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}

          <div className="mt-1 border-t border-border pt-1.5">
            {creating ? (
              <form onSubmit={createWorkspace} className="flex gap-1.5 px-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Workspace name"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-primary"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50"
                >
                  Add
                </button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-muted transition hover:bg-surface hover:text-ink"
              >
                + New workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
