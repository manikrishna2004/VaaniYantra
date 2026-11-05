import { describe, it, expect } from 'vitest';
import { hasPermission } from '@/lib/auth/permissions';
import { doctorScope } from '@/lib/auth/tenant';

// A doctor must see their own calendar and nobody else's.
//
// This was believed to be working and was not. Every scoped route decides
// self-vs-clinic with the same line:
//
//   const staff   = hasPermission(role, 'call:read');
//   const selfOnly = !staff && hasPermission(role, 'calendar:read_self');
//
// DOCTOR held call:read — granted as a workaround so the calendar surface could
// read Appointment rows — so `staff` was TRUE, `selfOnly` was FALSE, the scope
// was never applied, and a doctor saw every appointment in the clinic.
//
// These tests pin the inputs to that computation rather than the routes, because
// the routes all derive from it and the bug lived in the derivation.

describe('the staff/selfOnly computation every scoped route shares', () => {
  const staffFlag = (role: Parameters<typeof hasPermission>[0]) => hasPermission(role, 'call:read');
  const selfOnlyFlag = (role: Parameters<typeof hasPermission>[0]) =>
    !staffFlag(role) && hasPermission(role, 'calendar:read_self');

  it('treats a DOCTOR as self-only, never as staff', () => {
    expect(staffFlag('DOCTOR')).toBe(false);
    expect(selfOnlyFlag('DOCTOR')).toBe(true);
  });

  it('still treats real staff as staff, so the clinic view is unchanged', () => {
    for (const role of ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'] as const) {
      expect(staffFlag(role), `${role} staff`).toBe(true);
      expect(selfOnlyFlag(role), `${role} selfOnly`).toBe(false);
    }
  });

  // Both branches must be reachable for a doctor, or the route 403s them out of
  // their own calendar instead of scoping it.
  it('leaves a doctor able to pass the route guard', () => {
    expect(staffFlag('DOCTOR') || selfOnlyFlag('DOCTOR')).toBe(true);
  });
});

describe('what call:read carried with it', () => {
  // Removing it from DOCTOR was not only about the calendar: the same
  // permission gates transcripts, outcomes, portals and the CSV exports.
  it('no longer lets a doctor read the clinic-wide call surfaces', () => {
    expect(hasPermission('DOCTOR', 'call:read')).toBe(false);
    expect(hasPermission('DOCTOR', 'call:write')).toBe(false);
    expect(hasPermission('DOCTOR', 'patient:read')).toBe(false);
  });

  it('keeps what a doctor genuinely needs', () => {
    for (const perm of ['calendar:read_self', 'calendar:write_self', 'workspace:read', 'integration:connect_self'] as const) {
      expect(hasPermission('DOCTOR', perm), perm).toBe(true);
    }
  });
});

describe('doctorScope', () => {
  it('overrides a doctorId supplied by the caller rather than trusting it', () => {
    expect(doctorScope('mine', { doctorId: 'someone-else' } as Record<string, unknown>).doctorId).toBe('mine');
  });
});
