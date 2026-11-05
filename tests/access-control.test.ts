import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clientIp } from '@/lib/rate-limit';
import { hasPermission } from '@/lib/auth/permissions';

// Two kinds of guard here.
//
// The first is structural. Every one of these routes was written with
// `requireWorkspace()` or `apiContext()` and then simply never asked what the
// caller was allowed to do — the tenant was checked, the role was not. That is
// not a bug in the permission matrix, it is a route forgetting to consult it,
// and no amount of testing the matrix would have caught it. So this asserts the
// question is asked at all, which is the thing that kept being forgotten.
//
// It caught, among others, /api/calls/[id] returning a full patient transcript
// to anyone signed in — including a DOCTOR, whose call:read had just been
// removed specifically to stop that.

const ROOT = path.join(__dirname, '..', 'src', 'app', 'api');
const asks = (rel: string) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return /hasPermission\(|deny\(ctx,|isSuperAdmin\(/.test(src);
};

describe('sensitive routes consult the permission matrix', () => {
  const routes = [
    // Patient conversations, verbatim, plus the audio.
    'calls/route.ts',
    'calls/[id]/route.ts',
    'calls/[id]/recording/route.ts',
    'calls/[id]/transcript/route.ts',
    // Clinic-wide insights: volumes, sentiment, durations.
    'analytics/route.ts',
    // The practice's finances.
    'billing/route.ts',
    'billing/details/route.ts',
    'billing/invoices/route.ts',
    // What the phone agent reads out to patients as fact.
    'knowledge/route.ts',
    'knowledge/[id]/route.ts',
    'knowledge/faq/route.ts',
    // Agent configuration, including the system prompt.
    'agents/route.ts',
    'agents/[id]/route.ts',
  ];

  for (const rel of routes) {
    it(`${rel} checks a permission`, () => {
      expect(asks(rel)).toBe(true);
    });
  }
});

// The roles that exist to be limited. If any of these flips to true, a route
// that correctly consults the matrix starts leaking anyway.
describe('the roles those gates are protecting against', () => {
  const denied = {
    DOCTOR: ['call:read', 'insights:read', 'agent:read', 'knowledge:write', 'billing:manage'],
    VIEWER: ['knowledge:write', 'billing:manage'],
    MEMBER: ['billing:manage'],
  } as const;

  for (const [role, perms] of Object.entries(denied)) {
    for (const perm of perms) {
      it(`${role} cannot ${perm}`, () => {
        expect(hasPermission(role as never, perm as never)).toBe(false);
      });
    }
  }

  it('still lets a doctor do their own job', () => {
    for (const perm of ['calendar:read_self', 'calendar:write_self'] as const) {
      expect(hasPermission('DOCTOR', perm)).toBe(true);
    }
  });
});

// Every per-IP limit keys on this. If a caller can choose the key, the limit is
// decorative — including the one on the public walkthrough booker, which writes
// a real calendar event and sends real mail on each request.
describe('clientIp cannot be chosen by the caller', () => {
  const req = (h: Record<string, string>) => new Request('http://t/', { headers: h });

  it('takes the hop our own proxy appended, not the one the client sent', () => {
    expect(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('gives a spoofing caller the same bucket every time', () => {
    const a = clientIp(req({ 'x-forwarded-for': 'evil-1, 203.0.113.7' }));
    const b = clientIp(req({ 'x-forwarded-for': 'evil-2, 203.0.113.7' }));
    expect(a).toBe(b);
  });

  it('handles the ordinary single-hop case', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('tolerates whitespace and empty entries', () => {
    expect(clientIp(req({ 'x-forwarded-for': ' 9.9.9.9 ,  , 203.0.113.7 ' }))).toBe('203.0.113.7');
  });

  it('falls back when there is no forwarded header', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(req({}))).toBe('unknown');
  });
});
