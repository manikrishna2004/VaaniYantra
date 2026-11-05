import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '@prisma/client';

// The message the caller is promised at the end of the call.
//
// It went as the org's own free text, and a phone call opens no WhatsApp
// customer-service window — so Meta rejected every one of them unless the caller
// happened to have messaged the business in the last 24 hours, and there is no
// SMS underneath any more to catch it. The agent said "you'll get a WhatsApp
// confirmation", the caller got nothing, and the only trace was one line in the
// log. It now goes as the approved enquiry_registered template.

const prismaMock = vi.hoisted(() => ({
  outcome: { create: vi.fn(async (_args: unknown) => ({ id: 'outcome_1' })) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const sendMock = vi.hoisted(() =>
  vi.fn(async (_org: string, _to: string, _body: string, ..._t: unknown[]) => true),
);
vi.mock('@/lib/connectors', () => ({ sendConfirmation: sendMock }));

import { deliverOutcome } from '@/lib/connectors/outcomes';

const ORIGINAL_WA = process.env.WHATSAPP_ENABLED;

const agent = {
  id: 'agent_1',
  workspaceId: 'ws_1',
  agentType: 'other',
  outcomeConfig: {
    type: 'enquiry',
    captures: [
      { key: 'name', label: "Caller's name", required: true },
      { key: 'town', label: 'Town', required: true },
      { key: 'pincode', label: 'Pincode', required: true },
    ],
    callerTemplate:
      "Hi {{name}}, thanks for your interest in {{business}}. We've noted your project in {{town}} ({{pincode}}) and our sales team will contact you shortly.",
    ownerTemplate: 'New enquiry — {{name}}, project in {{town}} ({{pincode}}). Contact: {{callerNumber}}.',
    ownerNumbers: ['+919000000001'],
    deliver: { whatsapp: true, inApp: true },
  },
} as unknown as Agent;

const input = {
  orgId: 'org_1',
  workspaceId: 'ws_1',
  agent,
  callId: 'call_1',
  fields: { name: 'Rahul', town: 'Thane', pincode: '400601' },
  callerName: 'Rahul',
  callerNumber: '+919876543210',
  businessName: 'PARE India',
};

beforeEach(() => {
  process.env.WHATSAPP_ENABLED = 'true';
  sendMock.mockResolvedValue(true);
});
afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_WA === undefined) delete process.env.WHATSAPP_ENABLED;
  else process.env.WHATSAPP_ENABLED = ORIGINAL_WA;
});

describe('the caller acknowledgement', () => {
  it('goes as an approved template, not as free text', async () => {
    await deliverOutcome(input);
    const call = sendMock.mock.calls.find((c) => c[1] === '+919876543210');
    expect(call, 'the caller was not messaged at all').toBeDefined();
    // A 4th argument at all is the point: with no template, sendConfirmation
    // takes the free-text path Meta will not deliver.
    const tmpl = call![3] as { name: string; params: string[] } | undefined;
    expect(tmpl?.name).toBe('enquiry_registered');
    // Order follows the template body's placeholders, which Meta reads by
    // position: name, what it was, who with, the details.
    expect(tmpl?.params).toEqual(['Rahul', 'enquiry', 'PARE India', 'Thane, 400601']);
  });

  it("still passes the org's own wording, which is what the failure log shows", async () => {
    await deliverOutcome(input);
    const call = sendMock.mock.calls.find((c) => c[1] === '+919876543210');
    expect(call![2]).toBe(
      "Hi Rahul, thanks for your interest in PARE India. We've noted your project in Thane (400601) and our sales team will contact you shortly.",
    );
  });

  it('falls back on the caller name from the captured fields', async () => {
    // record_outcome passes callerName only when a field happens to be called
    // "name"; an agent that captures it under another key must not send Meta an
    // empty first parameter.
    await deliverOutcome({ ...input, callerName: null });
    const call = sendMock.mock.calls.find((c) => c[1] === '+919876543210');
    expect((call![3] as { params: string[] }).params[0]).toBe('Rahul');
  });

  it('reads back what the caller gave, minus the name they already know', async () => {
    const call = await deliverOutcome(input).then(() =>
      sendMock.mock.calls.find((c) => c[1] === '+919876543210'),
    );
    expect((call![3] as { params: string[] }).params[3]).toBe('Thane, 400601');
  });

  it('never sends an empty detail parameter, which Meta rejects outright', async () => {
    // An outcome can carry nothing but a name.
    await deliverOutcome({ ...input, fields: { name: 'Rahul' } });
    const call = sendMock.mock.calls.find((c) => c[1] === '+919876543210');
    expect((call![3] as { params: string[] }).params[3]).toBe('the details you gave us');
  });

  it('does not message a caller whose number we never got', async () => {
    await deliverOutcome({ ...input, callerNumber: null });
    expect(sendMock.mock.calls.some((c) => c[1] === '+919876543210')).toBe(false);
  });

  it('still alerts the sales number on its own template', async () => {
    await deliverOutcome(input);
    const owner = sendMock.mock.calls.find((c) => c[1] === '+919000000001');
    expect((owner![3] as { name: string }).name).toBe('owner_alert');
  });

  it('records the outcome even when nothing can be delivered', async () => {
    // The Outcome row is the feed and the CSV export; messaging is best-effort.
    sendMock.mockResolvedValue(false);
    const res = await deliverOutcome(input);
    expect(res.outcomeId).toBe('outcome_1');
  });
});
