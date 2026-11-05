'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Spinner } from '@/components/ui';
import { useConfirm } from '@/components/Feedback';
import { isValidPhoneNumber } from '@/lib/utils';

// Inline "place a test call" + delete actions for an agent.
export function AgentActions({ agentId, agentName }: { agentId: string; agentName: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [to, setTo] = useState('');
  const [placing, setPlacing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function placeCall() {
    if (!isValidPhoneNumber(to)) {
      setMsg('Enter a phone number with country code, e.g. +91 98765 43210');
      return;
    }
    setPlacing(true);
    setMsg(null);
    try {
      const res = await fetch('/api/calls/outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, to }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Failed');
      setMsg(
        data.simulated
          ? 'Simulated call started — it will appear in Call History shortly.'
          : 'Call placed.',
      );
      setTo('');
      setTimeout(() => router.push(`/calls/${data.id}`), 1200);
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setPlacing(false);
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: `Delete agent "${agentName}"?`,
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    setDeleting(true);
    await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
    router.push('/agents');
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[220px]">
        <label className="label">Place a test call</label>
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="+919876543210"
        />
      </div>
      <Button onClick={placeCall} disabled={placing}>
        {placing ? <Spinner /> : 'Call now'}
      </Button>
      <Button variant="danger" onClick={remove} disabled={deleting}>
        {deleting ? <Spinner /> : 'Delete agent'}
      </Button>
      {msg && <p className="w-full text-sm text-muted">{msg}</p>}
    </div>
  );
}
