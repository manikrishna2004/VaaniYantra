import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// The Meta WhatsApp webhook authenticates with an X-Hub-Signature-256 HMAC over
// the raw body. The check was written as:
//
//     if (meta.appSecret && !verifyMetaSignature(...)) return 401;
//
// so an install with no appSecret configured accepted *every* POST. That is not
// a quiet failure: the inbound path resolves an org, spends model tokens on a
// reply, and sends a WhatsApp message back out. Anyone who knew the URL could
// drive it. Authenticity that switches itself off when unconfigured is not
// authenticity, so a missing secret now refuses the request.
//
// verifyMetaSignature itself is exercised for real here rather than mocked —
// the whole point is whether a forged body is rejected.

const APP_SECRET = 'test-app-secret';

// Literal rather than APP_SECRET: vi.hoisted runs before module-level consts.
const metaConfig = vi.hoisted(() => ({ value: { appSecret: 'test-app-secret', verifyToken: 'vt' } as any }));
const handleInboundWhatsApp = vi.hoisted(() => vi.fn(async () => {}));
const resolveInboundWhatsappOrg = vi.hoisted(() =>
  vi.fn(async () => ({ orgId: 'o1', reason: 'patient-match' as const })),
);
const enabled = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/whatsapp-cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp-cloud')>()),
  getMetaConfig: vi.fn(async () => metaConfig.value),
}));
vi.mock('@/lib/connectors', () => ({ resolveInboundWhatsappOrg }));
vi.mock('@/lib/whatsapp-chat', () => ({ handleInboundWhatsApp }));
vi.mock('@/lib/flags', () => ({ whatsappEnabled: () => enabled.value }));

import { POST } from '@/app/api/whatsapp/webhook/route';

const inbound = {
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: '1234786513047967' },
            messages: [{ type: 'text', from: '+919876543210', text: { body: 'when is my appointment?' } }],
          },
        },
      ],
    },
  ],
};

const sign = (secret: string, raw: string) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

const post = (raw: string, signature?: string) =>
  new Request('http://test/api/whatsapp/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    body: raw,
  });

beforeEach(() => {
  vi.clearAllMocks();
  enabled.value = true;
  metaConfig.value = { appSecret: APP_SECRET, verifyToken: 'vt' };
});

describe('POST /api/whatsapp/webhook signature enforcement', () => {
  it('accepts a correctly signed body and processes the message', async () => {
    const raw = JSON.stringify(inbound);
    const res = await POST(post(raw, sign(APP_SECRET, raw)));

    expect(res.status).toBe(200);
    expect(handleInboundWhatsApp).toHaveBeenCalledOnce();
  });

  it('rejects a body signed with the wrong secret', async () => {
    const raw = JSON.stringify(inbound);
    const res = await POST(post(raw, sign('not-the-secret', raw)));

    expect(res.status).toBe(401);
    expect(handleInboundWhatsApp).not.toHaveBeenCalled();
  });

  it('rejects a tampered body that carries a signature for the original', async () => {
    const raw = JSON.stringify(inbound);
    const signature = sign(APP_SECRET, raw);
    const tampered = JSON.stringify({
      ...inbound,
      entry: [{ changes: [{ value: { metadata: { phone_number_id: 'attacker' }, messages: [] } }] }],
    });

    const res = await POST(post(tampered, signature));

    expect(res.status).toBe(401);
    expect(handleInboundWhatsApp).not.toHaveBeenCalled();
  });

  it('rejects a body with no signature header at all', async () => {
    const res = await POST(post(JSON.stringify(inbound)));

    expect(res.status).toBe(401);
    expect(handleInboundWhatsApp).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when no app secret is configured', async () => {
    // Previously this accepted the request: the signature check was skipped
    // entirely whenever appSecret was falsy.
    metaConfig.value = { appSecret: '', verifyToken: 'vt' };

    const res = await POST(post(JSON.stringify(inbound)));

    expect(res.status).toBe(401);
    expect(handleInboundWhatsApp).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the config is missing entirely', async () => {
    metaConfig.value = {};

    const raw = JSON.stringify(inbound);
    const res = await POST(post(raw, sign(APP_SECRET, raw)));

    expect(res.status).toBe(401);
    expect(handleInboundWhatsApp).not.toHaveBeenCalled();
  });

  it('still acknowledges without processing when WhatsApp is flagged off', async () => {
    // Meta disables a subscription that keeps erroring, so the flag-off path
    // must stay a 200 — it just does no work.
    enabled.value = false;

    const res = await POST(post(JSON.stringify(inbound)));

    expect(res.status).toBe(200);
    expect(handleInboundWhatsApp).not.toHaveBeenCalled();
  });
});
