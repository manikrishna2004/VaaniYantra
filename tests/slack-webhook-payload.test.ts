import { describe, it, expect, vi } from 'vitest';

// What a connected Slack channel is allowed to receive.
//
// A Slack Incoming Webhook is authenticated by the secrecy of its URL alone —
// Slack never verifies our HMAC — so the protection here is sending less, not
// signing more. The caller's number is incidental to the card's purpose and is
// masked; the summary is the reason the integration exists and is not.

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { formatSlackMessage } from '@/lib/webhooks';

const call = (over: Record<string, unknown> = {}) => ({
  event: 'call.completed',
  data: {
    direction: 'INBOUND',
    fromNumber: '+919876543210',
    toNumber: '+914045901102',
    agent: { name: 'Smile Dental' },
    durationSec: 92,
    sentiment: 'POSITIVE',
    status: 'COMPLETED',
    ...over,
  },
});

function numberField(payload: unknown) {
  const blocks = (payload as { blocks: any[] }).blocks;
  const section = blocks.find((b) => b.type === 'section' && b.fields);
  return section.fields.find((f: any) => f.text.startsWith('*Number:*')).text;
}

describe('formatSlackMessage — caller number', () => {
  it('sends only the last four digits of an inbound caller', () => {
    const field = numberField(formatSlackMessage(call()));
    expect(field).toContain('3210');
    expect(field).not.toContain('9876543210');
    expect(field).not.toContain('+91');
  });

  it('masks the dialled number on an outbound call too', () => {
    const field = numberField(formatSlackMessage(call({ direction: 'OUTBOUND' })));
    expect(field).toContain('1102');
    expect(field).not.toContain('4045901102');
  });

  it('degrades to a dash rather than leaking a short or missing value', () => {
    expect(numberField(formatSlackMessage(call({ fromNumber: null })))).toContain('—');
    expect(numberField(formatSlackMessage(call({ fromNumber: '12' })))).toContain('—');
  });
});

describe('formatSlackMessage — everything else', () => {
  it('keeps the card useful: agent, duration, sentiment, status', () => {
    const out = formatSlackMessage(call()) as { text: string; blocks: any[] };
    const flat = JSON.stringify(out);
    expect(out.text).toContain('Smile Dental');
    expect(flat).toContain('92');
    expect(flat).toContain('POSITIVE');
    expect(flat).toContain('COMPLETED');
  });

  it('still carries the summary — that is what the clinic connected Slack for', () => {
    const out = formatSlackMessage(call({ summary: 'Booked a cleaning for Tuesday.' }));
    expect(JSON.stringify(out)).toContain('Booked a cleaning for Tuesday.');
  });
});
