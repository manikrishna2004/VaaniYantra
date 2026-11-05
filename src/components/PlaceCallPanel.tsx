'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Button, Input, Select, Spinner } from '@/components/ui';
import { isValidPhoneNumber } from '@/lib/utils';

type Agent = { id: string; name: string };
type Num = { id: string; e164: string; label: string | null };

export function PlaceCallPanel({ agents, numbers }: { agents: Agent[]; numbers: Num[] }) {
  const router = useRouter();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [fromNumberId, setFromNumberId] = useState(numbers[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [placing, setPlacing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function placeCall() {
    if (!agentId) {
      setMsg('Create an agent first.');
      return;
    }
    if (!isValidPhoneNumber(to)) {
      setMsg('Enter a valid destination number, e.g. +919876543210');
      return;
    }
    setPlacing(true);
    setMsg(null);
    try {
      const res = await fetch('/api/calls/outbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, to, fromNumberId: fromNumberId || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Failed to place call');
      setMsg(data.simulated ? 'Simulated call started…' : 'Call placed.');
      setTo('');
      setTimeout(() => router.refresh(), 1500);
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setPlacing(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-sm font-medium text-ink">Place an outbound call</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label">Agent</label>
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.length === 0 && <option value="">No agents</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="label">From</label>
          <Select value={fromNumberId} onChange={(e) => setFromNumberId(e.target.value)}>
            <option value="">Default caller ID</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.e164} {n.label ? `· ${n.label}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="label">To</label>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+919876543210" />
        </div>
        <div className="flex items-end">
          <Button onClick={placeCall} disabled={placing} className="w-full">
            {placing ? <Spinner /> : 'Call now'}
          </Button>
        </div>
      </div>
      {msg && <p className="mt-3 text-sm text-muted">{msg}</p>}
    </Card>
  );
}
