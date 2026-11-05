import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { isTokenLive, SESSION_COOKIE } from '@/lib/auth/session-cookie';

// Route gating and the cookie-liveness heuristic behind it.
//
// The heuristic is deliberately weak — Edge cannot verify a signature — so the
// tests pin down both what it does and, more importantly, what must never be
// built on top of it.

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.signature-not-checked`;
}

const live = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
const expired = () => jwt({ exp: Math.floor(Date.now() / 1000) - 3600 });

function req(path: string, cookie?: string): NextRequest {
  const r = new NextRequest(new URL(`https://vaaniyantra.com${path}`));
  if (cookie) r.cookies.set(SESSION_COOKIE, cookie);
  return r;
}

function locationOf(res: Response | undefined): string | null {
  const loc = res?.headers.get('location');
  return loc ? new URL(loc).pathname + new URL(loc).search : null;
}

describe('isTokenLive', () => {
  it('accepts a token whose exp is in the future', () => {
    expect(isTokenLive(live())).toBe(true);
  });

  it('rejects an expired token', () => {
    expect(isTokenLive(expired())).toBe(false);
  });

  it('rejects missing and malformed tokens', () => {
    expect(isTokenLive(undefined)).toBe(false);
    expect(isTokenLive('')).toBe(false);
    expect(isTokenLive('not-a-jwt')).toBe(false);
    expect(isTokenLive('only.two')).toBe(false);
    expect(isTokenLive('a.!!!not-base64!!!.c')).toBe(false);
  });

  it('rejects a token with no exp claim', () => {
    expect(isTokenLive(jwt({ sub: 'user' }))).toBe(false);
  });

  it('does NOT verify the signature — the whole reason nothing may trust it', () => {
    // Anyone can craft this. It is why the real check is getSessionUser(), and
    // why middleware must not grant access on the strength of this alone.
    expect(isTokenLive(jwt({ exp: Math.floor(Date.now() / 1000) + 999999 }))).toBe(true);
  });
});

describe('protecting app routes', () => {
  const routes = [
    '/dashboard', '/agents', '/calls', '/live', '/appointments', '/updates',
    '/reports', '/knowledge', '/chatbot', '/patients', '/connectors',
    '/numbers', '/team', '/settings', '/admin', '/my-practice', '/checkout',
    // Outside the (app) group (it prints without the sidebar) but still
    // authenticated — an emailed invoice link opened while signed out used to
    // lose its ?next= and strand the user on the dashboard.
    '/invoices',
  ];

  it.each(routes)('redirects %s to sign-in when there is no cookie', (path) => {
    expect(locationOf(middleware(req(path)))).toBe(`/sign-in?next=${encodeURIComponent(path)}`);
  });

  it.each(routes)('preserves %s as the post-login destination', (path) => {
    // Regression: eight of these were missing from PROTECTED_PREFIXES, so they
    // fell through to requireWorkspace()'s bare /sign-in and the user was
    // dumped on the dashboard instead of where they were heading.
    expect(locationOf(middleware(req(path)))).toContain(`next=${encodeURIComponent(path)}`);
  });

  it('protects nested paths too', () => {
    expect(locationOf(middleware(req('/settings/billing')))).toContain('next=%2Fsettings%2Fbilling');
    expect(locationOf(middleware(req('/patients/abc123')))).toContain('next=%2Fpatients%2Fabc123');
    expect(locationOf(middleware(req('/invoices/inv_123')))).toContain('next=%2Finvoices%2Finv_123');
  });

  it('lets a request with a live cookie through to real verification', () => {
    expect(locationOf(middleware(req('/dashboard', live())))).toBeNull();
  });

  it('redirects when the cookie is present but expired', () => {
    expect(locationOf(middleware(req('/dashboard', expired())))).toBe('/sign-in?next=%2Fdashboard');
  });
});

describe('never trapping the user in a redirect loop', () => {
  // Regression: middleware used to bounce /sign-in -> /dashboard whenever the
  // cookie merely decoded. A tampered, revoked, or previous-Firebase-project
  // token has a future exp but fails real verification, so /dashboard sent it
  // straight back to /sign-in — forever, with no way to reach the form and
  // sign out.
  it('serves /sign-in even when a live-looking cookie is present', () => {
    expect(locationOf(middleware(req('/sign-in', live())))).toBeNull();
  });

  it('serves /sign-up even when a live-looking cookie is present', () => {
    expect(locationOf(middleware(req('/sign-up', live())))).toBeNull();
  });

  it('serves /sign-in with a forged cookie', () => {
    const forged = jwt({ exp: Math.floor(Date.now() / 1000) + 86400, sub: 'attacker' });
    expect(locationOf(middleware(req('/sign-in', forged)))).toBeNull();
  });
});

describe('public routes stay public', () => {
  it.each(['/', '/pricing', '/docs', '/docs/integration-guide', '/contact', '/security', '/c/some-clinic'])(
    'does not gate %s',
    (path) => {
      expect(locationOf(middleware(req(path)))).toBeNull();
    },
  );

  it('does not gate a patient portal link carrying a key', () => {
    // Patients are not platform users; gating this would break every link.
    expect(locationOf(middleware(req('/c/smile-care-dental?k=abc123')))).toBeNull();
  });
});
