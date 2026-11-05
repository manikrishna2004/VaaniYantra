'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { defaultUhidPrefix } from '@/lib/patients/uhid-format';

export function OrgSettings({
  name,
  slug,
  brandColor,
  dataRetentionDays,
  uhidPrefix,
  memberCount,
  canManage,
}: {
  name: string;
  slug: string;
  brandColor: string | null;
  dataRetentionDays: number | null;
  uhidPrefix: string | null;
  memberCount: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [orgName, setOrgName] = useState(name);
  const [color, setColor] = useState(brandColor ?? '#6366f1');
  const [retention, setRetention] = useState<string>(dataRetentionDays ? String(dataRetentionDays) : '');
  const [prefix, setPrefix] = useState(uhidPrefix ?? '');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // What the server would derive if the field is left blank — shown as the
  // placeholder so the field is never a mystery box.
  const suggestedPrefix = defaultUhidPrefix(orgName);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    const res = await fetch('/api/organization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: orgName,
        brandColor: color,
        dataRetentionDays: retention.trim() === '' ? null : parseInt(retention, 10),
        uhidPrefix: prefix.trim() === '' ? null : prefix.trim(),
      }),
    });
    setSaving(false);
    setNote(res.ok ? 'Saved.' : 'Could not save.');
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-sm font-medium text-ink">Organization</h2>
        <form onSubmit={save} className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Name</label>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              disabled={!canManage}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary disabled:text-muted"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Slug</label>
            <input
              value={slug}
              disabled
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-muted"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Brand color <span className="text-muted">(white-label)</span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                disabled={!canManage}
                className="h-9 w-12 cursor-pointer rounded border border-border-strong bg-surface-2"
              />
              <span className="text-sm text-muted">{color}</span>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Patient number prefix
            </label>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              disabled={!canManage}
              placeholder={suggestedPrefix}
              maxLength={6}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm uppercase tracking-wider text-ink outline-none focus:border-primary disabled:text-muted"
            />
            <p className="mt-1.5 text-xs text-muted">
              Every patient is given a number automatically —{' '}
              <code className="text-ink-soft">{(prefix || suggestedPrefix) + '-000147'}</code>. Changing this only
              affects patients registered from now on; anyone already on file keeps the number printed on their
              records.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Call data retention <span className="text-muted">(days)</span>
            </label>
            <input
              type="number"
              min={1}
              max={3650}
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              disabled={!canManage}
              placeholder="Keep forever"
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary disabled:text-muted"
            />
            <p className="mt-1.5 text-xs text-muted">
              Transcripts, recordings and summaries of calls older than this are deleted
              automatically (checked every few hours). Call counts and durations are kept for
              billing. Leave empty to keep call data forever.
            </p>
          </div>
          {canManage && (
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {note && <span className="text-xs text-muted">{note}</span>}
            </div>
          )}
          {!canManage && (
            <p className="text-xs text-muted">Only admins and owners can edit organization settings.</p>
          )}
        </form>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-sm font-medium text-ink">Members</h2>
        <p className="mt-1 text-sm text-muted">
          {memberCount} {memberCount === 1 ? 'member' : 'members'}. Manage them on the{' '}
          <Link href="/team" className="text-ink underline">
            Team
          </Link>{' '}
          page.
        </p>
      </section>
    </div>
  );
}
