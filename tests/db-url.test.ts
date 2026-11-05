import { describe, it, expect } from 'vitest';
import { buildDatasourceUrl } from '@/lib/db';

describe('buildDatasourceUrl', () => {
  it('returns undefined when no base url', () => {
    // Note: passing `undefined` would fall back to the process.env default, so
    // exercise the empty-base branch with an explicit empty string.
    expect(buildDatasourceUrl('', '10')).toBeUndefined();
  });

  it('leaves SQLite urls untouched (no pool)', () => {
    expect(buildDatasourceUrl('file:./dev.db', '10')).toBe('file:./dev.db');
  });

  it('appends connection_limit to a bare postgres url', () => {
    expect(buildDatasourceUrl('postgresql://u:p@h:5432/db', '12')).toBe(
      'postgresql://u:p@h:5432/db?connection_limit=12',
    );
  });

  it('uses & when the url already has query params', () => {
    expect(buildDatasourceUrl('postgresql://u:p@h/db?schema=public', '8')).toBe(
      'postgresql://u:p@h/db?schema=public&connection_limit=8',
    );
  });

  it('does not double-set an existing connection_limit', () => {
    const url = 'postgresql://u:p@h/db?connection_limit=5';
    expect(buildDatasourceUrl(url, '20')).toBe(url);
  });

  it('ignores invalid/zero/negative limits', () => {
    const url = 'postgresql://u:p@h/db';
    expect(buildDatasourceUrl(url, undefined)).toBe(url);
    expect(buildDatasourceUrl(url, '0')).toBe(url);
    expect(buildDatasourceUrl(url, '-3')).toBe(url);
    expect(buildDatasourceUrl(url, 'abc')).toBe(url);
  });
});
