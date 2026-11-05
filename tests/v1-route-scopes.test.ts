import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, sep } from 'path';
import { API_SCOPES } from '@/lib/api/scopes';

// ── The guard ───────────────────────────────────────────────────────────────
//
// Scope enforcement is opt-in per call site: `requireApiAuth(req)` still
// authenticates and returns a context, it just asserts no action. That is the
// right signature — a non-route caller has no action to assert — but it means
// the next v1 endpoint someone adds will authenticate correctly and authorize
// nothing, and nothing about that reads as wrong in review.
//
// So the rule is enforced here instead of in the type system: every
// requireApiAuth call under src/app/api/v1 must name a scope. This is the test
// that would have caught the original gap, where ApiKey.scopes existed and no
// route ever looked at it.

const V1 = join(process.cwd(), 'src', 'app', 'api', 'v1');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

const files = routeFiles(V1);
const rel = (f: string) => f.slice(process.cwd().length + 1).split(sep).join('/');

// Matches `requireApiAuth(req)` / `requireApiAuth(req, 'scope')`, capturing the
// scope argument when there is one.
const CALL = /requireApiAuth\(\s*req\s*(?:,\s*'([^']*)'\s*)?\)/g;

describe('every v1 route names a scope', () => {
  it('finds the v1 routes at all', () => {
    // A refactor that moves or renames the directory must fail loudly rather
    // than silently checking nothing.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files.map((f) => [rel(f), f]))('%s', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    const calls = [...src.matchAll(CALL)];

    expect(calls.length).toBeGreaterThan(0);
    for (const [, scope] of calls) {
      expect(scope, 'requireApiAuth must be given a scope in a v1 route').toBeTruthy();
      expect(API_SCOPES as readonly string[]).toContain(scope);
    }
  });

  it('has one requireApiAuth call per exported handler', () => {
    // An exported handler with no call is an unauthenticated public endpoint;
    // two handlers sharing one call means a path that skipped the check.
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
      const calls = [...src.matchAll(CALL)];
      expect(calls.length, `${rel(file)}: handlers vs requireApiAuth calls`).toBe(handlers.length);
    }
  });

  it('never grants a write scope to a read-only handler', () => {
    // Ordering: the Nth requireApiAuth call belongs to the Nth handler, since
    // each handler contains exactly one (asserted above).
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      const scopes = [...src.matchAll(CALL)].map((m) => m[1]);
      handlers.forEach((verb, i) => {
        if (verb === 'GET') {
          expect(scopes[i], `${rel(file)}: GET must not require a write scope`).toMatch(/:read$/);
        }
      });
    }
  });
});
