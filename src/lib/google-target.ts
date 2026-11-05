// Which Google Calendar connection an OAuth round-trip is for.
//
//   'org'      — the clinic's shared calendar (admins)
//   'me'       — the signed-in doctor's own calendar
//   'platform' — VaaniYantra's OWN calendar, used for "book a call with our
//                team". Not a tenant's data at all: it is stored in
//                PlatformConfig rather than the Integration table, and only a
//                super-admin may connect it.
//
// The target has to survive the redirect to Google and back. It rides inside
// the `state` parameter rather than in a second cookie: state already makes the
// round trip, and keeping one cookie means the CSRF check stays a single
// comparison instead of two things that can disagree.
//
// Only the random half is ever compared against the cookie — the target half is
// attacker-controllable in principle, which is why the callback re-checks the
// caller's permission for whichever target came back rather than trusting it.

export type CalendarTarget = 'org' | 'me' | 'platform';

export function parseTarget(raw: string | null | undefined): CalendarTarget {
  if (raw === 'me') return 'me';
  if (raw === 'platform') return 'platform';
  return 'org';
}

export function encodeState(target: CalendarTarget, nonce: string): string {
  return `${target}.${nonce}`;
}

/** Split a returned state into its target and the nonce to verify. */
export function decodeState(state: string | null | undefined): { target: CalendarTarget; nonce: string } {
  const [head, ...rest] = (state ?? '').split('.');
  // A state minted before targets existed has no prefix; treat it as the org
  // connection, which is what it was.
  if (rest.length === 0) return { target: 'org', nonce: head ?? '' };
  return { target: parseTarget(head), nonce: rest.join('.') };
}
