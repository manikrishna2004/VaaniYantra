'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { Card, Badge, Button, Spinner, EmptyState } from '@/components/ui';
import { useConfirm, useToast } from '@/components/Feedback';

type Appointment = {
  id: string;
  customerName: string;
  customerNumber: string | null;
  patientNo: string | null;
  contactId: string | null;
  expertName: string | null;
  service: string;
  startAt: string;
  endAt: string;
  timezone: string | null;
  status: 'CONFIRMED' | 'CANCELLED';
  // null when no confirmation was attempted (no number on the booking).
  confirmationDelivered?: boolean | null;
};

function fmt(iso: string, tz: string | null) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz || undefined,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function AppointmentsManager({ canManage }: { canManage: boolean }) {
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  async function load() {
    const res = await fetch('/api/appointments');
    setAppts(res.ok ? await res.json() : []);
  }
  useEffect(() => {
    load();
  }, []);

  async function cancel(a: Appointment) {
    if (
      !(await confirm({
        title: `Cancel ${a.service}?`,
        message: `${a.customerName} · ${fmt(a.startAt, a.timezone)}. The calendar event is removed and the customer is notified.`,
        confirmLabel: 'Cancel appointment',
        danger: true,
      }))
    )
      return;
    setCancelling(a.id);
    try {
      const res = await fetch(`/api/appointments/${a.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast('Appointment cancelled.', 'success');
        setAppts((list) => (list ?? []).map((x) => (x.id === a.id ? { ...x, status: 'CANCELLED' } : x)));
      } else {
        const b = await res.json().catch(() => ({}));
        toast(b.error || 'Could not cancel.', 'error');
      }
    } finally {
      setCancelling(null);
    }
  }

  if (!appts) return <Spinner />;

  const now = Date.now();
  const upcoming = appts.filter((a) => a.status === 'CONFIRMED' && new Date(a.startAt).getTime() >= now);
  const past = appts.filter((a) => !(a.status === 'CONFIRMED' && new Date(a.startAt).getTime() >= now));

  if (appts.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="No appointments yet"
        description="When an agent books an appointment on a call, it shows up here. Enable Appointment booking on an agent and connect Google Calendar under Connectors."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Section title="Upcoming" empty="No upcoming appointments.">
        {upcoming.map((a) => (
          <Row key={a.id} a={a} canManage={canManage} cancelling={cancelling === a.id} onCancel={() => cancel(a)} />
        ))}
      </Section>
      {past.length > 0 && (
        <Section title="Past & cancelled">
          {past.map((a) => (
            <Row key={a.id} a={a} canManage={false} cancelling={false} onCancel={() => {}} muted />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty?: string; children: React.ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  return (
    <div>
      <h2 className="mb-2 text-sm font-medium text-ink">{title}</h2>
      {arr.length === 0 && empty ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </div>
  );
}

function Row({
  a,
  canManage,
  cancelling,
  onCancel,
  muted,
}: {
  a: Appointment;
  canManage: boolean;
  cancelling: boolean;
  onCancel: () => void;
  muted?: boolean;
}) {
  const isPast = new Date(a.startAt).getTime() < Date.now();
  return (
    <Card className={`flex flex-wrap items-center justify-between gap-3 p-4 ${muted ? 'opacity-70' : ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink capitalize">
            {a.service}
            {a.expertName ? ` · ${a.expertName}` : ''}
          </span>
          {a.status === 'CANCELLED' ? (
            <Badge tone="danger">cancelled</Badge>
          ) : isPast ? (
            <Badge tone="neutral">past</Badge>
          ) : (
            <Badge tone="success">confirmed</Badge>
          )}
          {/* The caller was told on the phone that a WhatsApp was coming. When
              it was refused there is nothing to see anywhere else, so the front
              desk finds out from the patient. */}
          {a.confirmationDelivered === false && a.status !== 'CANCELLED' && (
            <Badge tone="warning">confirmation not delivered</Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          {a.contactId ? (
            <Link href={`/patients/${a.contactId}`} className="truncate text-ink-soft transition hover:text-primary">
              {a.customerName}
            </Link>
          ) : (
            <span className="truncate">{a.customerName}</span>
          )}
          {a.patientNo && <code className="tabular-nums">{a.patientNo}</code>}
          {a.customerNumber && <span>· {a.customerNumber}</span>}
          <span>· {fmt(a.startAt, a.timezone)}</span>
        </div>
      </div>
      {canManage && a.status === 'CONFIRMED' && !isPast && (
        <Button size="sm" variant="danger" onClick={onCancel} disabled={cancelling}>
          {cancelling ? <Spinner /> : 'Cancel'}
        </Button>
      )}
    </Card>
  );
}
