import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1-4: unknown Twilio statuses are ignored, and non-terminal updates can't
// overwrite a call that already ended.

const prismaMock = vi.hoisted(() => ({
  call: { updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { POST } from '@/app/api/telephony/twilio/status/route';

function statusRequest(callStatus: string): Request {
  return new Request('http://test/api/telephony/twilio/status?callId=c1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallStatus: callStatus, CallDuration: '42' }).toString(),
  });
}

describe('POST /api/telephony/twilio/status', () => {
  beforeEach(() => {
    prismaMock.call.updateMany.mockClear();
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
  });

  it('ignores unknown statuses entirely', async () => {
    const res = await POST(statusRequest('some-future-status'));
    expect(res.status).toBe(200);
    expect(prismaMock.call.updateMany).not.toHaveBeenCalled();
  });

  it('applies terminal statuses with endedAt/endedReason', async () => {
    await POST(statusRequest('completed'));
    const arg = prismaMock.call.updateMany.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ id: 'c1' });
    expect(arg.data.status).toBe('COMPLETED');
    expect(arg.data.endedReason).toBe('completed');
    expect(arg.data.endedAt).toBeInstanceOf(Date);
  });

  it('guards non-terminal updates against already-ended calls', async () => {
    await POST(statusRequest('ringing'));
    const arg = prismaMock.call.updateMany.mock.calls[0][0] as any;
    expect(arg.where.id).toBe('c1');
    expect(arg.where.status).toEqual({ notIn: ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'] });
    expect(arg.data.status).toBe('RINGING');
    expect(arg.data.endedAt).toBeUndefined();
  });

  it('rejects when signature validation is on and no signature is sent', async () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await POST(statusRequest('completed'));
    expect(res.status).toBe(403);
    expect(prismaMock.call.updateMany).not.toHaveBeenCalled();
  });
});
