import { describe, it, expect } from 'vitest';
import { permissionsFor, hasPermission, toRole, ROLES, type Permission } from '@/lib/auth/permissions';
import { doctorScope } from '@/lib/auth/tenant';

// The DOCTOR role exists because the nearest alternative was far too much.
//
// Before it, giving a doctor a login meant making them a MEMBER — which grants
// agent:write, agent:delete and clinic-wide patient:read/write. A doctor who
// wanted to see their own schedule could also delete every agent in the clinic
// and read every patient record in it. These assertions are the guard on that.

const FORBIDDEN_FOR_DOCTOR: Permission[] = [
  'agent:write',
  'agent:delete',
  'patient:read',
  'patient:write',
  'patient:delete',
  'member:manage',
  'integration:manage',
  'apikey:manage',
  'billing:manage',
  'org:manage',
  'audit:read',
  // The clinic-wide appointment write. A doctor moves their own bookings via
  // calendar:write_self plus the doctorScope filter, never this.
  'call:write',
];

describe('the DOCTOR role', () => {
  it('is a real role', () => {
    expect(ROLES).toContain('DOCTOR');
    expect(toRole('DOCTOR')).toBe('DOCTOR');
  });

  it('can manage its own calendar', () => {
    expect(hasPermission('DOCTOR', 'calendar:read_self')).toBe(true);
    expect(hasPermission('DOCTOR', 'calendar:write_self')).toBe(true);
  });

  it('can attach its own Google account', () => {
    expect(hasPermission('DOCTOR', 'integration:connect_self')).toBe(true);
  });

  it('cannot touch anything clinic-wide', () => {
    for (const p of FORBIDDEN_FOR_DOCTOR) {
      expect(hasPermission('DOCTOR', p), `DOCTOR must not hold ${p}`).toBe(false);
    }
  });

  it('holds strictly less than MEMBER', () => {
    const doctor = new Set(permissionsFor('DOCTOR'));
    const member = new Set(permissionsFor('MEMBER'));
    // Not a subset — DOCTOR has calendar:*_self, which MEMBER lacks — but it
    // must not hold any of MEMBER's clinic-wide writes.
    for (const p of ['patient:write', 'call:write', 'knowledge:write'] as Permission[]) {
      expect(member.has(p)).toBe(true);
      expect(doctor.has(p)).toBe(false);
    }
  });

  // agent:* left MEMBER for ADMIN when setup was tightened. A doctor must hold
  // it at neither level, which is the assertion that actually matters here.
  it('cannot touch agents at any level', () => {
    const doctor = new Set(permissionsFor('DOCTOR'));
    for (const p of ['agent:write', 'agent:delete', 'number:write'] as Permission[]) {
      expect(doctor.has(p)).toBe(false);
    }
    expect(permissionsFor('ADMIN')).toContain('agent:write');
  });

  it('gives staff the calendar permissions too, so they can manage every doctor', () => {
    for (const role of ['ADMIN', 'OWNER'] as const) {
      expect(hasPermission(role, 'calendar:read_self')).toBe(true);
      expect(hasPermission(role, 'calendar:write_self')).toBe(true);
    }
  });

  it('does not leak the calendar permissions to VIEWER', () => {
    expect(hasPermission('VIEWER', 'calendar:read_self')).toBe(false);
    expect(hasPermission('VIEWER', 'calendar:write_self')).toBe(false);
  });
});

describe('doctorScope', () => {
  it('adds the doctor filter', () => {
    expect(doctorScope('doc1', { status: 'CONFIRMED' })).toEqual({ status: 'CONFIRMED', doctorId: 'doc1' });
  });

  it('cannot be overridden by the caller', () => {
    // The tenant helpers spread the key last for exactly this reason: a `where`
    // built from request input must never be able to widen its own scope.
    const hostile = { doctorId: 'someone-else' } as Record<string, unknown>;
    expect(doctorScope('doc1', hostile).doctorId).toBe('doc1');
  });

  it('throws rather than silently matching every doctor', () => {
    // An empty id returning an unscoped clause would hand one doctor the whole
    // clinic's calendar — the exact failure this helper exists to prevent.
    expect(() => doctorScope('')).toThrow();
  });
});
