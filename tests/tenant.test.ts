import { describe, it, expect } from 'vitest';
import {
  TenantScopeError,
  assertSameOrg,
  assertSameWorkspace,
  orgScope,
  workspaceScope,
} from '@/lib/auth/tenant';

describe('assertSameOrg', () => {
  it('passes when org ids match', () => {
    expect(() => assertSameOrg('org1', 'org1')).not.toThrow();
  });
  it('throws on mismatch', () => {
    expect(() => assertSameOrg('org2', 'org1')).toThrow(TenantScopeError);
  });
  it('throws when the resource org is missing', () => {
    expect(() => assertSameOrg(null, 'org1')).toThrow(TenantScopeError);
    expect(() => assertSameOrg(undefined, 'org1')).toThrow(TenantScopeError);
  });
});

describe('assertSameWorkspace', () => {
  it('passes on match, throws on mismatch/missing', () => {
    expect(() => assertSameWorkspace('w1', 'w1')).not.toThrow();
    expect(() => assertSameWorkspace('w2', 'w1')).toThrow(TenantScopeError);
    expect(() => assertSameWorkspace(null, 'w1')).toThrow(TenantScopeError);
  });
});

describe('orgScope / workspaceScope', () => {
  it('injects the tenant key', () => {
    expect(orgScope('org1')).toEqual({ orgId: 'org1' });
    expect(workspaceScope('w1', { status: 'ACTIVE' })).toEqual({ status: 'ACTIVE', workspaceId: 'w1' });
  });

  it('the tenant key cannot be overridden by the caller where clause', () => {
    // Even a malicious/buggy where trying to widen scope is overwritten.
    const scoped = orgScope('org1', { orgId: 'attacker-org', status: 'x' } as any);
    expect(scoped.orgId).toBe('org1');
    expect(scoped.status).toBe('x');
  });

  it('requires a tenant id', () => {
    expect(() => orgScope('')).toThrow(TenantScopeError);
    expect(() => workspaceScope('')).toThrow(TenantScopeError);
  });
});
