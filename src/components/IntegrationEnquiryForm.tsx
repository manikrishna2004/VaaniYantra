'use client';

import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Spinner, Textarea } from '@/components/ui';

// "Tell us what you need." One card, six fields, no wizard.
//
// This replaced a three-step slot booker. The questions here are the ones we
// used to spend the first half of a demo call asking — how the front desk works
// now, which systems are already in place, what the agent should actually do —
// so the reply we send can be about their setup rather than a generic pitch.

type Status = 'idle' | 'sending' | 'sent';

export function IntegrationEnquiryForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [orgName, setOrgName] = useState('');
  const [callsPerDay, setCallsPerDay] = useState('');
  const [requirements, setRequirements] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setStatus('sending');
    const res = await fetch('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, orgName, callsPerDay, requirements }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      setStatus('idle');
      setError(body.error ?? 'Could not send that. Please try again, or email info@vaaniyantra.com.');
      return;
    }
    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <Card className="space-y-3">
        <Badge tone="success">Sent</Badge>
        <h2 className="font-display text-display-sm text-ink">Thank you — we have it</h2>
        <p className="text-sm leading-relaxed text-ink-soft">
          A confirmation is on its way to <span className="text-ink">{email}</span>. One of us will read what you
          sent and come back within one working day with what it would take to fit VaaniYantra to how{' '}
          {orgName || 'your practice'} already works.
        </p>
        <p className="text-xs text-muted">
          In a hurry? Reply to that email, or write to info@vaaniyantra.com — it reaches the same person.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Meera Rao" />
        </Field>
        <Field label="Work email" hint="Where our reply goes.">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@clinic.in"
          />
        </Field>
        <Field label="Clinic or hospital">
          <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Smilecare Dental" />
        </Field>
        <Field label="Phone" hint="Optional — if you would rather we called.">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Approx. calls per day" hint="Optional — it decides what this costs you.">
          <Input value={callsPerDay} onChange={(e) => setCallsPerDay(e.target.value)} placeholder="e.g. 40" />
        </Field>
      </div>
      <Field
        label="What do you want it to do?"
        hint="How calls are answered today, which system you run (if any), the languages your patients use, and what you want handled automatically."
      >
        <Textarea
          rows={5}
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
          placeholder="Two receptionists answer until 8pm and after that the line rings out. We use a local PMS for appointments. Patients call in Telugu and English, mostly to book or reschedule, and ask about timings and fees…"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={send} disabled={status === 'sending'}>
          {status === 'sending' ? <Spinner /> : 'Send this to us'}
        </Button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </Card>
  );
}
