import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deleting an organisation.
//
// `prisma.organization.delete` alone leaves five tables standing, still holding
// patient names, phone numbers and call transcripts: Call (workspaceId is
// SetNull and there is no orgId at all), Appointment, Outcome, WhatsappTurn and
// PortalOtp (plain String ids, no FK anywhere). Someone following the old
// manual process saw the tenant vanish from the app and believed the data was
// gone. These tests pin the sweep that fixes it — and its ORDER, which is the
// part that is easy to break later.

const order: string[] = [];
const record = (name: string, count = 0) => async () => {
  order.push(name);
  return { count };
};

const tx = vi.hoisted(() => ({
  call: { deleteMany: vi.fn() },
  appointment: { deleteMany: vi.fn() },
  outcome: { deleteMany: vi.fn() },
  whatsappTurn: { deleteMany: vi.fn() },
  portalOtp: { deleteMany: vi.fn() },
  organization: { delete: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  organization: { findUnique: vi.fn(), delete: vi.fn() },
  workspace: { findMany: vi.fn() },
  call: { count: vi.fn(async () => 0), deleteMany: vi.fn() },
  transcriptTurn: { count: vi.fn(async () => 0) },
  appointment: { count: vi.fn(async () => 0), deleteMany: vi.fn() },
  outcome: { count: vi.fn(async () => 0), deleteMany: vi.fn() },
  whatsappTurn: { count: vi.fn(async () => 0), deleteMany: vi.fn() },
  portalOtp: { count: vi.fn(async () => 0), deleteMany: vi.fn() },
  contact: { count: vi.fn(async () => 0) },
  visitRecord: { count: vi.fn(async () => 0) },
  auditLog: { count: vi.fn(async () => 0) },
  $transaction: vi.fn(async (fn: (t: unknown) => unknown, _opts: { timeout: number; maxWait: number }) => fn(tx)),
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { countOrgData, deleteOrganization } from '@/lib/org-delete';

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  prismaMock.organization.findUnique.mockResolvedValue({ id: 'o1', name: 'Smile Dental' });
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
  tx.call.deleteMany.mockImplementation(record('call'));
  tx.appointment.deleteMany.mockImplementation(record('appointment'));
  tx.outcome.deleteMany.mockImplementation(record('outcome'));
  tx.whatsappTurn.deleteMany.mockImplementation(record('whatsappTurn'));
  tx.portalOtp.deleteMany.mockImplementation(record('portalOtp'));
  tx.organization.delete.mockImplementation(async () => {
    order.push('organization');
    return {};
  });
});

describe('countOrgData', () => {
  it('returns null for an organisation that does not exist', async () => {
    prismaMock.organization.findUnique.mockResolvedValue(null);
    expect(await countOrgData('nope')).toBeNull();
  });

  it('counts without deleting anything', async () => {
    prismaMock.call.count.mockResolvedValue(120);
    prismaMock.contact.count.mockResolvedValue(40);

    const report = await countOrgData('o1');

    expect(report).toMatchObject({
      orgId: 'o1',
      orgName: 'Smile Dental',
      applied: false,
      counts: expect.objectContaining({ calls: 120, contacts: 40, workspaces: 2 }),
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('deleteOrganization', () => {
  it('sweeps the unparented tables before deleting the organisation', async () => {
    await deleteOrganization('o1');

    // Order is load-bearing. Calls MUST go while workspaceId still resolves —
    // Call has no orgId, so once the workspace cascade fires there is nothing
    // left to attribute them by and the transcripts are orphaned forever.
    expect(order[0]).toBe('call');
    expect(order[order.length - 1]).toBe('organization');
    expect(order).toEqual([
      'call',
      'appointment',
      'outcome',
      'whatsappTurn',
      'portalOtp',
      'organization',
    ]);
  });

  it('scopes the call sweep to the org’s workspaces', async () => {
    await deleteOrganization('o1');
    expect(tx.call.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: { in: ['w1', 'w2'] } },
    });
  });

  it('scopes the FK-less tables by orgId', async () => {
    await deleteOrganization('o1');
    for (const t of [tx.appointment, tx.outcome, tx.whatsappTurn, tx.portalOtp]) {
      expect(t.deleteMany).toHaveBeenCalledWith({ where: { orgId: 'o1' } });
    }
  });

  it('runs as one transaction, so a failure leaves the tenant whole', async () => {
    await deleteOrganization('o1');
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // A busy hospital does not delete inside the default 5s budget.
    const opts = prismaMock.$transaction.mock.calls[0][1];
    expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
  });

  it('returns null for an unknown organisation and deletes nothing', async () => {
    prismaMock.organization.findUnique.mockResolvedValue(null);
    expect(await deleteOrganization('nope')).toBeNull();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
