import { describe, it, expect, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn(async (_a: unknown) => null as any) },
  organization: { findUnique: vi.fn(async (_a: unknown) => null as any) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import {
  canUseService,
  canSignIn,
  isOrgStatus,
  suspendedMessage,
  orgStatus,
  orgStatusForWorkspace,
} from '@/lib/org-status';

describe('what each status stops', () => {
  it('only ACTIVE may place or answer calls', () => {
    expect(canUseService('ACTIVE')).toBe(true);
    expect(canUseService('PAUSED')).toBe(false);
    expect(canUseService('DEACTIVATED')).toBe(false);
  });

  // The whole point of having two stopped states: a paused org is usually one
  // chasing an invoice, and they cannot pay it if they cannot reach billing.
  it('PAUSED still lets staff sign in; DEACTIVATED does not', () => {
    expect(canSignIn('ACTIVE')).toBe(true);
    expect(canSignIn('PAUSED')).toBe(true);
    expect(canSignIn('DEACTIVATED')).toBe(false);
  });
});

describe('orgStatus', () => {
  it('treats an unknown organisation as DEACTIVATED, not as active', async () => {
    prismaMock.organization.findUnique.mockResolvedValueOnce(null);
    expect(await orgStatus('nope')).toEqual({ status: 'DEACTIVATED', reason: null });
    expect(canUseService((await orgStatus('nope')).status)).toBe(false);
  });

  it('returns the stored status and reason', async () => {
    prismaMock.organization.findUnique.mockResolvedValueOnce({ status: 'PAUSED', statusReason: 'Invoice overdue' });
    expect(await orgStatus('o1')).toEqual({ status: 'PAUSED', reason: 'Invoice overdue' });
  });
});

describe('orgStatusForWorkspace', () => {
  it('is null for a number that belongs to no workspace, so routing is unaffected', async () => {
    expect(await orgStatusForWorkspace(null)).toBeNull();
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });

  it('reads through the workspace to its org', async () => {
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ org: { status: 'DEACTIVATED', statusReason: null } });
    expect(await orgStatusForWorkspace('ws1')).toEqual({ status: 'DEACTIVATED', reason: null });
  });
});

describe('suspendedMessage', () => {
  it('appends the operator reason when there is one', () => {
    expect(suspendedMessage('PAUSED', 'Invoice overdue.')).toBe('This account is paused. Invoice overdue.');
    expect(suspendedMessage('DEACTIVATED', null)).toBe('This account has been deactivated.');
    expect(suspendedMessage('PAUSED', '   ')).toBe('This account is paused.');
  });
});

describe('isOrgStatus', () => {
  it('rejects anything not in the set, so a typo cannot strand an org', () => {
    expect(isOrgStatus('ACTIVE')).toBe(true);
    expect(isOrgStatus('paused')).toBe(false);
    expect(isOrgStatus('SUSPENDED')).toBe(false);
    expect(isOrgStatus(undefined)).toBe(false);
  });
});
