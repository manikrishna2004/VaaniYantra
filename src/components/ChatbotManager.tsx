'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bot, Check, Copy, ExternalLink, MessageCircle, Plus, Trash2 } from 'lucide-react';
import { Card, Badge, Button, Input, Textarea, Select, Field, Spinner, EmptyState, Modal } from '@/components/ui';
import { useConfirm, useToast } from '@/components/Feedback';

type Portal = {
  id: string;
  name: string;
  slug: string;
  url: string;
  greeting: string | null;
  enabled: boolean;
  allowRecords: boolean;
  allowBooking: boolean;
  allowDownloads: boolean;
  agentId: string | null;
  agent: { id: string; name: string } | null;
};
type Agent = { id: string; name: string };

export function ChatbotManager({ canManage }: { canManage: boolean }) {
  const [portals, setPortals] = useState<Portal[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [creating, setCreating] = useState(false);
  // Nothing is created until this dialog is opened and submitted. Creating a
  // chatbot mints a public URL and starts answering patients, so it is an
  // explicit act, never a side-effect of landing on the page.
  const [composing, setComposing] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    const [pRes, aRes] = await Promise.all([fetch('/api/portals'), fetch('/api/agents')]);
    setPortals(pRes.ok ? (await pRes.json()).portals : []);
    if (aRes.ok) setAgents(await aRes.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch('/api/portals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, agentId: agentId || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || 'Could not create the chatbot.', 'error');
        return;
      }
      toast('Chatbot created. Its link now rides along with every appointment confirmation.', 'success');
      setName('');
      setAgentId('');
      setComposing(false);
      load();
    } finally {
      setCreating(false);
    }
  }

  async function patch(id: string, data: Record<string, unknown>) {
    const res = await fetch(`/api/portals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) load();
    else toast('Could not save that change.', 'error');
  }

  async function remove(p: Portal) {
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      message:
        'Every link already sent to your patients stops working immediately, and their chat history is deleted. Their visit records are kept.',
      confirmLabel: 'Delete chatbot',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/portals/${p.id}`, { method: 'DELETE' });
    if (res.ok) {
      toast('Chatbot deleted.', 'success');
      load();
    }
  }

  if (!portals) return <Spinner />;

  const createButton = canManage ? (
    <Button onClick={() => setComposing(true)}>
      <Plus className="h-4 w-4" />
      Create chatbot
    </Button>
  ) : null;

  return (
    <div className="space-y-5">
      {portals.length > 0 && createButton && <div className="flex justify-end">{createButton}</div>}

      {portals.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No chatbot yet"
          description={
            canManage
              ? 'Create one and every patient your agents book gets its link with their appointment confirmation. They sign in with their mobile number and a code.'
              : 'Ask an admin to create your clinic’s chatbot.'
          }
          action={createButton}
        />
      ) : (
        portals.map((p) => (
          <PortalCard key={p.id} portal={p} agents={agents} canManage={canManage} onPatch={patch} onDelete={remove} />
        ))
      )}

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        title="Create a chatbot"
        description="It goes live on its own public link as soon as you create it. You can pause or delete it at any time."
      >
        <form onSubmit={create} className="space-y-4">
          <Field label="Name" hint="What your patients see at the top of the chat. Use your clinic's name.">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Smile Dental Care"
              required
              maxLength={80}
            />
          </Field>
          <Field
            label="Answers from"
            hint="Pick the agent whose knowledge base and persona the chatbot should use — normally the one answering your phone."
          >
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Select an agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setComposing(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? <Spinner /> : 'Create chatbot'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function PortalCard({
  portal,
  agents,
  canManage,
  onPatch,
  onDelete,
}: {
  portal: Portal;
  agents: Agent[];
  canManage: boolean;
  onPatch: (id: string, data: Record<string, unknown>) => void;
  onDelete: (p: Portal) => void;
}) {
  const [name, setName] = useState(portal.name);
  const [greeting, setGreeting] = useState(portal.greeting ?? '');
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(portal.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <div className="h-display text-base font-semibold">{portal.name}</div>
            <div className="text-xs text-muted">
              {portal.agent ? `Answers from ${portal.agent.name}` : 'No agent linked — it can only greet'}
            </div>
          </div>
        </div>
        {portal.enabled ? <Badge tone="success">live</Badge> : <Badge tone="neutral">paused</Badge>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-soft">
            {portal.url}
          </code>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <a href={portal.url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
          </a>
        </div>
        <p className="text-xs text-muted">
          This is your clinic&apos;s public address — safe to print, share, or put on your website. Opening it asks the
          patient for their mobile number and texts them a code, so each one only ever reaches their own records.
        </p>
        <div className="rounded-xl border border-border bg-surface-2 p-3.5">
          <p className="text-xs font-medium text-ink">Want to try it yourself?</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs text-muted">
            <li>
              Go to{' '}
              <Link href="/patients" className="text-primary">
                Patients
              </Link>{' '}
              and add yourself, using your own mobile number.
            </li>
            <li>Open your new patient record and record a consultation — a prescription is enough.</li>
            <li>Open the link above, enter that same mobile number, and type the code you receive.</li>
          </ol>
          <p className="mt-2 text-xs text-muted">
            Patients your agents book get this link automatically, with their appointment confirmation.
          </p>
        </div>
      </div>

      {canManage && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name !== portal.name && onPatch(portal.id, { name })}
                maxLength={80}
              />
            </Field>
            <Field label="Answers from">
              <Select
                value={portal.agentId ?? ''}
                onChange={(e) => onPatch(portal.id, { agentId: e.target.value || null })}
              >
                <option value="">No agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Greeting" hint="The first thing a patient sees. Leave blank for a sensible default.">
            <Textarea
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              onBlur={() => greeting !== (portal.greeting ?? '') && onPatch(portal.id, { greeting })}
              className="min-h-[70px]"
              maxLength={500}
              placeholder="Hi! I'm the assistant for Smile Dental Care. Ask me about your prescription or your next visit."
            />
          </Field>

          <div className="space-y-2.5">
            <Toggle
              label="Show visit records"
              hint="Patients can read the prescriptions and advice you file for them."
              checked={portal.allowRecords}
              onChange={(v) => onPatch(portal.id, { allowRecords: v })}
            />
            <Toggle
              label="Allow file downloads"
              hint="Patients can open the prescription scans you attached."
              checked={portal.allowDownloads}
              onChange={(v) => onPatch(portal.id, { allowDownloads: v })}
            />
            <Toggle
              label="Allow booking changes"
              hint="Patients can book, move and cancel appointments in the chat. Needs Google Calendar connected and booking enabled on the agent."
              checked={portal.allowBooking}
              onChange={(v) => onPatch(portal.id, { allowBooking: v })}
            />
            <Toggle
              label="Chatbot is live"
              hint="Turn off to take it down without deleting anything."
              checked={portal.enabled}
              onChange={(v) => onPatch(portal.id, { enabled: v })}
            />
          </div>

          <div className="border-t border-border pt-4">
            <Button size="sm" variant="danger" onClick={() => onDelete(portal)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete chatbot
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-border-strong"
      />
      <span>
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}
