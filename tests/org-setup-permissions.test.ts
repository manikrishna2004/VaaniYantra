import { describe, it, expect } from 'vitest';
import { hasPermission, homePathFor } from '@/lib/auth/permissions';

// Setup actions were tightened to the practice owner. These pin the boundary,
// because the failure mode is silent in both directions: too loose and a
// front-desk seat buys phone numbers, too tight and a doctor cannot attach
// their own calendar.

describe('org-level setup is owner-only', () => {
  const setup = ['number:write', 'integration:manage', 'apikey:manage', 'billing:manage', 'org:manage'] as const;

  it('grants every setup permission to OWNER and to nobody else', () => {
    for (const perm of setup) {
      expect(hasPermission('OWNER', perm), `OWNER ${perm}`).toBe(true);
      for (const role of ['ADMIN', 'MEMBER', 'VIEWER', 'DOCTOR'] as const) {
        expect(hasPermission(role, perm), `${role} ${perm}`).toBe(false);
      }
    }
  });

  it('leaves agents to ADMIN — operations, not setup', () => {
    expect(hasPermission('ADMIN', 'agent:write')).toBe(true);
    expect(hasPermission('ADMIN', 'agent:delete')).toBe(true);
    expect(hasPermission('MEMBER', 'agent:write')).toBe(false);
    expect(hasPermission('DOCTOR', 'agent:write')).toBe(false);
  });

  // The carve-out that makes the tightening survivable: connecting YOUR OWN
  // calendar is a different permission from connecting the clinic's.
  it('still lets a doctor attach their own calendar', () => {
    expect(hasPermission('DOCTOR', 'integration:connect_self')).toBe(true);
    expect(hasPermission('DOCTOR', 'integration:manage')).toBe(false);
  });

  it('leaves reading alone, so staff can still see the setup', () => {
    for (const role of ['MEMBER', 'ADMIN', 'OWNER'] as const) {
      expect(hasPermission(role, 'number:read')).toBe(true);
      expect(hasPermission(role, 'agent:read')).toBe(true);
    }
  });
});

describe('clinic-wide oversight is ADMIN and OWNER only', () => {
  // Dashboard, live calls and reports. A front-desk seat works the appointment
  // book; a doctor works their own calendar. Neither needs the whole practice's
  // volume and outcomes.
  it('grants insights:read to ADMIN and OWNER, nobody else', () => {
    expect(hasPermission('OWNER', 'insights:read')).toBe(true);
    expect(hasPermission('ADMIN', 'insights:read')).toBe(true);
    for (const role of ['MEMBER', 'VIEWER', 'DOCTOR'] as const) {
      expect(hasPermission(role, 'insights:read'), role).toBe(false);
    }
  });

  it('keeps agents out of a doctor’s and a member’s reach', () => {
    for (const role of ['MEMBER', 'VIEWER', 'DOCTOR'] as const) {
      expect(hasPermission(role, 'agent:write'), role).toBe(false);
    }
  });

  // The redirect target matters: /dashboard is the default landing, so without a
  // per-role home a doctor signs in and bounces off an error.
  it('sends each role somewhere it can actually work', () => {
    expect(homePathFor('OWNER')).toBe('/dashboard');
    expect(homePathFor('ADMIN')).toBe('/dashboard');
    expect(homePathFor('DOCTOR')).toBe('/my-practice');
    expect(homePathFor('MEMBER')).toBe('/appointments');
    expect(homePathFor('VIEWER')).toBe('/appointments');
  });

  it('never sends anyone to a page their role cannot open', () => {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'DOCTOR'] as const) {
      const home = homePathFor(role);
      if (home === '/dashboard') expect(hasPermission(role, 'insights:read'), role).toBe(true);
      if (home === '/my-practice') expect(hasPermission(role, 'calendar:write_self'), role).toBe(true);
    }
  });
});
