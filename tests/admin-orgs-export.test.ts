import { describe, it, expect } from 'vitest';
import {
  matchesOrgFilters,
  orgCsv,
  parseOrgPeriod,
  periodSince,
  periodLabel,
  type AdminOrgRow,
} from '@/lib/admin-orgs';
import { toCsv } from '@/lib/reports';

const row = (over: Partial<AdminOrgRow> = {}): AdminOrgRow => ({
  id: 'o1',
  name: 'Smilecare Dental',
  plan: 'growth',
  createdAt: '2026-01-05T10:00:00.000Z',
  termsAcceptedAt: '2026-01-06T10:00:00.000Z',
  termsVersion: '2026-08-27',
  ownerEmail: 'owner@smilecare.in',
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: null,
  minutes: 120,
  calls: 40,
  agents: 2,
  phoneNumbers: 1,
  _count: { workspaces: 1, memberships: 3 },
  ...over,
});

describe('matchesOrgFilters', () => {
  it('treats "all" and absent the same way', () => {
    expect(matchesOrgFilters(row(), {})).toBe(true);
    expect(matchesOrgFilters(row(), { plan: 'all', status: 'all', numbers: 'all', agents: 'all' })).toBe(true);
  });

  it('filters on plan and status', () => {
    expect(matchesOrgFilters(row(), { plan: 'free' })).toBe(false);
    expect(matchesOrgFilters(row(), { plan: 'growth' })).toBe(true);
    expect(matchesOrgFilters(row({ status: 'PAUSED' }), { status: 'ACTIVE' })).toBe(false);
  });

  // The onboarding question this table exists to answer: who built an agent but
  // never connected a number?
  it('isolates orgs that never connected a number', () => {
    const stalled = row({ phoneNumbers: 0, agents: 1 });
    expect(matchesOrgFilters(stalled, { numbers: 'without', agents: 'with' })).toBe(true);
    expect(matchesOrgFilters(row(), { numbers: 'without' })).toBe(false);
  });
});

describe('periods', () => {
  it('defaults to the calendar month, which is what billing bills on', () => {
    expect(parseOrgPeriod(null)).toBe('month');
    expect(parseOrgPeriod('nonsense')).toBe('month');
    expect(parseOrgPeriod('90')).toBe('90');
    expect(periodSince('month')!.getDate()).toBe(1);
  });

  it('all time has no lower bound', () => {
    expect(periodSince('all')).toBeNull();
    expect(periodLabel('all')).toBe('All time');
  });
});

describe('orgCsv', () => {
  it('names the period in the usage headers, so a stray file is still readable', () => {
    const { header } = orgCsv([row()], '90');
    expect(header).toContain('Minutes (Last 90 days)');
    expect(header).toContain('Owner email');
  });

  // The guarantee that makes this safe to hand to a marketing team.
  it('carries no patient data — only business columns', () => {
    const { header } = orgCsv([row()], 'month');
    const forbidden = /patient|transcript|recording|diagnosis|prescription|caller/i;
    for (const h of header) expect(h, `${h} looks like patient data`).not.toMatch(forbidden);
  });

  it('escapes a comma in an organisation name rather than splitting the row', () => {
    const { header, body } = orgCsv([row({ name: 'Shah, Patel & Co' })], 'month');
    const csv = toCsv(header, body);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Shah, Patel & Co"');
  });

  it('renders dates as plain days and empty strings for missing values', () => {
    const { body } = orgCsv([row({ termsAcceptedAt: null, termsVersion: null, ownerEmail: null })], 'month');
    expect(body[0]).toContain('2026-01-05');
    expect(body[0][1]).toBe('');
    expect(body[0][13]).toBe('');
  });
});
