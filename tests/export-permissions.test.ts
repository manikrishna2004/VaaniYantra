import { describe, it, expect } from 'vitest';

// Who can carry which export out of the building.
//
// permissions.ts splits `patient:read` out of `call:read` on purpose, so a
// read-only seat (auditor, demo login, front-desk stand-in) sees call history
// and no medical records. The CSV route used to gate all four export types on
// `call:read` — which VIEWER holds — so `?type=patients` handed a VIEWER the
// whole patient list with dates of birth, defeating the split.

import { hasPermission } from '@/lib/auth/permissions';
import { EXPORT_PERMISSION, EXPORT_TYPES } from '@/lib/reports';

describe('export permission mapping', () => {
  it('covers every export type', () => {
    for (const t of EXPORT_TYPES) {
      expect(EXPORT_PERMISSION[t]).toBeDefined();
    }
  });

  it('requires patient:read for the exports carrying patient data', () => {
    // Both of these include names and phone numbers; patients also includes DOB.
    expect(EXPORT_PERMISSION.patients).toBe('patient:read');
    expect(EXPORT_PERMISSION.appointments).toBe('patient:read');
  });

  it('leaves call-only exports on call:read', () => {
    expect(EXPORT_PERMISSION.calls).toBe('call:read');
    expect(EXPORT_PERMISSION.outcomes).toBe('call:read');
  });
});

describe('what each role can export', () => {
  it('VIEWER can export calls but not patients or appointments', () => {
    expect(hasPermission('VIEWER', EXPORT_PERMISSION.calls)).toBe(true);
    expect(hasPermission('VIEWER', EXPORT_PERMISSION.outcomes)).toBe(true);
    expect(hasPermission('VIEWER', EXPORT_PERMISSION.patients)).toBe(false);
    expect(hasPermission('VIEWER', EXPORT_PERMISSION.appointments)).toBe(false);
  });

  it('clinical staff (MEMBER and up) can export everything', () => {
    for (const role of ['MEMBER', 'ADMIN', 'OWNER'] as const) {
      for (const t of EXPORT_TYPES) {
        expect(hasPermission(role, EXPORT_PERMISSION[t])).toBe(true);
      }
    }
  });

  it('a signed-out caller can export nothing', () => {
    for (const t of EXPORT_TYPES) {
      expect(hasPermission(null, EXPORT_PERMISSION[t])).toBe(false);
    }
  });
});
