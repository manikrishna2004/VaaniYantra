import { describe, it, expect, vi, beforeEach } from 'vitest';

// Households are an authorization boundary, not a convenience. These pin down
// who may see whose appointments once one phone number belongs to a family.

const db = vi.hoisted(() => ({ contacts: [] as any[] }));

vi.mock('@/lib/db', () => ({
  prisma: {
    contact: {
      findMany: vi.fn(async (a: any) => {
        const w = a.where ?? {};
        return db.contacts.filter(
          (c) =>
            (w.orgId === undefined || c.orgId === w.orgId) &&
            (w.phone === undefined || c.phone === w.phone) &&
            (w.guardianContactId === undefined || c.guardianContactId === w.guardianContactId) &&
            (w.portalRevokedAt === undefined || c.portalRevokedAt === w.portalRevokedAt),
        );
      }),
    },
  },
}));

const { viewableContactIds, appointmentScope, householdByPhone, isPrimary, PRIMARY_KEY } = await import(
  '@/lib/patients/household'
);

const PHONE = '+919876543210';
const mother = {
  id: 'c-mother',
  orgId: 'org-A',
  phone: PHONE,
  dependentKey: PRIMARY_KEY,
  guardianContactId: null,
  portalRevokedAt: null,
} as any;
const child = {
  id: 'c-child',
  orgId: 'org-A',
  phone: PHONE,
  dependentKey: 'dep-1',
  guardianContactId: 'c-mother',
  portalRevokedAt: null,
} as any;
const sibling = {
  id: 'c-sibling',
  orgId: 'org-A',
  phone: PHONE,
  dependentKey: 'dep-2',
  guardianContactId: 'c-mother',
  portalRevokedAt: null,
} as any;

beforeEach(() => {
  db.contacts = [mother, child, sibling];
});

describe('isPrimary', () => {
  it('is the empty sentinel, not null', () => {
    expect(isPrimary(mother)).toBe(true);
    expect(isPrimary(child)).toBe(false);
    expect(PRIMARY_KEY).toBe('');
  });
});

describe('viewableContactIds', () => {
  it('lets a guardian see themselves and their dependents', async () => {
    const ids = await viewableContactIds(mother);
    expect(ids).toEqual(['c-mother', 'c-child', 'c-sibling']);
  });

  it('never lets a dependent see a sibling', async () => {
    // The critical one: sharing a handset must not mean sharing records.
    const ids = await viewableContactIds(child);
    expect(ids).toEqual(['c-child']);
    expect(ids).not.toContain('c-sibling');
    expect(ids).not.toContain('c-mother');
  });
});

describe('appointmentScope', () => {
  it('is always bound to the org', async () => {
    const scope = await appointmentScope(mother);
    expect(scope.orgId).toBe('org-A');
  });

  it('matches linked appointments for the whole household when primary', async () => {
    const scope: any = await appointmentScope(mother);
    expect(scope.OR[0]).toEqual({ contactId: { in: ['c-mother', 'c-child', 'c-sibling'] } });
  });

  it('gives the primary a legacy leg restricted to UNLINKED rows', async () => {
    // Without the contactId:null guard, a linked appointment would be visible to
    // anyone sharing the number — a lateral read between siblings.
    const scope: any = await appointmentScope(mother);
    expect(scope.OR).toHaveLength(2);
    expect(scope.OR[1]).toEqual({ contactId: null, customerNumber: PHONE });
  });

  it('gives a dependent NO legacy phone leg at all', async () => {
    // A dependent can only exist after households shipped, so it has no
    // legitimate unlinked rows — and the phone leg would hand it the family's
    // entire appointment history.
    const scope: any = await appointmentScope(child);
    expect(scope.OR).toHaveLength(1);
    expect(scope.OR[0]).toEqual({ contactId: { in: ['c-child'] } });
    expect(JSON.stringify(scope)).not.toContain(PHONE);
  });

  it('a lone patient behaves exactly as before households existed', async () => {
    db.contacts = [mother];
    const scope: any = await appointmentScope(mother);
    expect(scope.OR).toEqual([
      { contactId: { in: ['c-mother'] } },
      { contactId: null, customerNumber: PHONE },
    ]);
  });
});

describe('householdByPhone', () => {
  it('returns the primary first so sign-in defaults to the number owner', async () => {
    const rows = await householdByPhone('org-A', PHONE);
    expect(rows[0].id).toBe('c-mother');
  });

  it('excludes a blocked member without locking out the rest of the family', async () => {
    db.contacts = [mother, { ...child, portalRevokedAt: new Date() }];
    const rows = await householdByPhone('org-A', PHONE);
    expect(rows.map((r: any) => r.id)).toEqual(['c-mother']);
  });
});
