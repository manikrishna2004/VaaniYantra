import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ROLES,
  type Role,
  type Permission,
  hasPermission,
  permissionsFor,
  toRole,
  roleRank,
  assertPermission,
} from '@/lib/auth/permissions';

// The RBAC matrix had no test at all, despite being the single gate in front of
// every write in the product. These assertions are deliberately explicit rather
// than derived from the matrix — a test that recomputes the thing it is checking
// would pass no matter what the grants became.

describe('role matrix', () => {
  const can = (role: Role, perm: Permission) => hasPermission(role, perm);

  it('gives VIEWER reads and nothing else', () => {
    for (const perm of ['agent:read', 'number:read', 'knowledge:read', 'call:read', 'member:read'] as Permission[]) {
      expect(can('VIEWER', perm)).toBe(true);
    }
    for (const perm of [
      'agent:write',
      'agent:delete',
      'number:write',
      'knowledge:write',
      'call:write',
      'member:manage',
      'billing:manage',
      'org:manage',
      'audit:read',
      'apikey:manage',
      'integration:manage',
      // A read-only account must not be able to attach credentials to the org.
      'integration:connect_self',
    ] as Permission[]) {
      expect(can('VIEWER', perm)).toBe(false);
    }
  });

  it('does not let MEMBER manage people, billing, keys, numbers, agents or the org', () => {
    expect(can('MEMBER', 'call:write')).toBe(true);
    expect(can('MEMBER', 'knowledge:write')).toBe(true);
    for (const perm of [
      // Setup is not a shift task: building an agent is ADMIN, and buying a
      // number spends the clinic's money, so it is OWNER.
      'agent:write',
      'agent:delete',
      'number:write',
      'member:manage',
      'billing:manage',
      'org:manage',
      'apikey:manage',
      'apikey:read',
      'audit:read',
      'integration:manage',
      'workspace:write',
      'workspace:delete',
    ] as Permission[]) {
      expect(can('MEMBER', perm)).toBe(false);
    }
  });

  it('lets ADMIN run the clinic but not set it up', () => {
    expect(can('ADMIN', 'member:manage')).toBe(true);
    expect(can('ADMIN', 'audit:read')).toBe(true);
    // Agents are operations — an admin builds and edits them.
    expect(can('ADMIN', 'agent:write')).toBe(true);
    expect(can('ADMIN', 'agent:delete')).toBe(true);
    // Everything that spends money, binds the practice or issues a credential
    // is the owner's.
    for (const perm of [
      'number:write',
      'integration:manage',
      'apikey:manage',
      'billing:manage',
      'org:manage',
    ] as Permission[]) {
      expect(can('ADMIN', perm)).toBe(false);
    }
  });

  // A doctor connecting their OWN Google calendar must survive the tightening
  // above — it is a different permission from integration:manage.
  it('still lets a doctor attach their own calendar', () => {
    expect(can('DOCTOR', 'integration:connect_self')).toBe(true);
    expect(can('DOCTOR', 'integration:manage')).toBe(false);
    expect(can('MEMBER', 'integration:connect_self')).toBe(true);
  });

  it('gives OWNER everything every lesser role has', () => {
    for (const role of ROLES) {
      for (const perm of permissionsFor(role)) {
        expect(can('OWNER', perm)).toBe(true);
      }
    }
  });

  it('keeps each role a superset of the one below it', () => {
    const ordered: Role[] = ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'];
    for (let i = 1; i < ordered.length; i++) {
      for (const perm of permissionsFor(ordered[i - 1])) {
        expect(can(ordered[i], perm)).toBe(true);
      }
      expect(roleRank(ordered[i])).toBeGreaterThan(roleRank(ordered[i - 1]));
    }
  });

  it('grants nothing at all for a missing role', () => {
    expect(hasPermission(null, 'call:read')).toBe(false);
    expect(hasPermission(undefined, 'agent:read')).toBe(false);
    expect(() => assertPermission(null, 'call:read')).toThrow(/Forbidden/);
  });
});

describe('patient records are not a read-only-seat privilege', () => {
  // Patient routes used to gate on call:read / call:write, which VIEWER holds,
  // so a read-only seat could pull a full medical record including the doctor's
  // private internalNotes. Records now sit behind their own permission.
  it('withholds patient access from VIEWER', () => {
    expect(hasPermission('VIEWER', 'patient:read')).toBe(false);
    expect(hasPermission('VIEWER', 'patient:write')).toBe(false);
  });

  it('grants patient access from MEMBER upward', () => {
    for (const role of ['MEMBER', 'ADMIN', 'OWNER'] as Role[]) {
      expect(hasPermission(role, 'patient:read')).toBe(true);
      expect(hasPermission(role, 'patient:write')).toBe(true);
    }
  });

  it('keeps patient access separate from call access', () => {
    // The two must not be re-collapsed: VIEWER legitimately reads call history.
    expect(hasPermission('VIEWER', 'call:read')).toBe(true);
    expect(hasPermission('VIEWER', 'patient:read')).toBe(false);
  });
});

describe('toRole fails closed', () => {
  it('maps a valid role to itself', () => {
    for (const role of ROLES) expect(toRole(role)).toBe(role);
  });

  it('maps anything unrecognised to the LEAST privilege, not a middling one', () => {
    // This value is read straight off Membership.role in the database
    // (auth/context.ts). A legacy, mistyped or hand-edited value must degrade to
    // read-only rather than silently granting writes.
    for (const bad of ['', null, undefined, 'member', 'SUPERUSER', 'Owner', 'admin']) {
      expect(toRole(bad)).toBe('VIEWER');
    }
    expect(hasPermission(toRole('nonsense'), 'call:write')).toBe(false);
    expect(hasPermission(toRole('nonsense'), 'patient:read')).toBe(false);
  });
});

// ── Route-level enforcement ────────────────────────────────────────────────
// The matrix being right is worthless if a route asks for the wrong permission,
// so drive the real handlers with a VIEWER context.

const ctxRole = vi.hoisted(() => ({ value: 'VIEWER' as Role }));

vi.mock('@/lib/auth/context', () => ({
  getWorkspaceContext: vi.fn(async () => ({
    user: { id: 'u1', email: 'v@example.com' },
    org: { id: 'o1', name: 'Org' },
    workspace: { id: 'w1', name: 'WS' },
    role: ctxRole.value,
  })),
  requireWorkspace: vi.fn(async () => ({
    user: { id: 'u1', email: 'v@example.com' },
    org: { id: 'o1', name: 'Org' },
    workspace: { id: 'w1', name: 'WS' },
    role: ctxRole.value,
  })),
}));

const prismaMock = vi.hoisted(() => ({
  contact: {
    findFirst: vi.fn(async () => ({ id: 'c1', orgId: 'o1', firstName: 'A', phone: '+919876543210' })),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    create: vi.fn(async () => ({ id: 'c1' })),
  },
  visitRecord: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'v1' })) },
  allergy: { findMany: vi.fn(async () => []) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

import { GET as listPatients, POST as createPatient } from '@/app/api/patients/route';
import { GET as getPatient } from '@/app/api/patients/[id]/route';

beforeEach(() => {
  vi.clearAllMocks();
  ctxRole.value = 'VIEWER';
});

describe('patients routes enforce the patient permission', () => {
  it('403s a VIEWER listing patients', async () => {
    const res = await listPatients(new Request('http://test/api/patients'));
    expect(res.status).toBe(403);
  });

  it('403s a VIEWER reading one patient record', async () => {
    const res = await getPatient(new Request('http://test/api/patients/c1'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect(res.status).toBe(403);
    // And the record must not have been fetched on the way to being refused.
    expect(prismaMock.visitRecord.findMany).not.toHaveBeenCalled();
  });

  it('403s a VIEWER creating a patient', async () => {
    const res = await createPatient(
      new Request('http://test/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'A', phone: '+919876543210' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
  });

  it('still lets a MEMBER list patients', async () => {
    ctxRole.value = 'MEMBER';
    const res = await listPatients(new Request('http://test/api/patients'));
    expect(res.status).toBe(200);
  });
});
