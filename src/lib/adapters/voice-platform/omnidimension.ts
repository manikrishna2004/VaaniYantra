import { fetchWithTimeout } from '@/lib/net/fetch';
import { assertPublicUrl } from '@/lib/net/ssrf';
import type {
  ListCallsPage,
  SubAccount,
  VoicePlatformCallRecord,
  VoicePlatformProvider,
} from '@/lib/adapters/voice-platform/types';

// OmniDimension, as a reseller.
//
// Built against their published OpenAPI (docs.omnidim.io) and their TypeScript
// SDK, so the paths and field names below are theirs, not guesses:
//
//   GET  /reseller/organizations      child orgs, with cost_per_min + org_balance
//   POST /reseller/credits/transfer   { to_organization_id, minutes, cost_per_min }
//   POST /reseller/credits/revert     { from_organization_id, minutes }
//   GET  /calls/logs                  ?pageno&pagesize&agentid&call_status
//   GET  /calls/logs/{id}
//
// ── Two constraints their API imposes on us ─────────────────────────────────
//
// 1. THERE IS NO DATE FILTER, AND NO UPDATED-AT. `/calls/logs` accepts only
//    pageno, pagesize, agentid, call_status and bulk_call_id, and a call record
//    has no modified timestamp. So we page newest-first and stop at the highest
//    id we already hold; a correction to an older call is invisible until that
//    call is read again, which is what the month-end full re-pull is for.
//
// 2. TIMESTAMPS ARE AMBIGUOUS LOCAL STRINGS. `time_of_call` comes back as
//    "05/04/2026 14:46:15" — no offset, and no way to tell 5 April from 4 May
//    from the value alone. That string decides which month a minute is billed
//    in, so `parseTimeOfCall` refuses to guess: it reports the timestamp as
//    INEXACT unless the day is above 12, and a run containing inexact records
//    is not allowed to close a month.
//
// ⚠ UNVERIFIED UNTIL THE SPIKE: whether a reseller key can read a CHILD's call
// logs, or whether each child needs its own key. `/calls/logs` is scoped to the
// key that calls it and the docs do not say. `callsAuthFor` is the single place
// that decision lives — if it turns out each child needs its own key, that is a
// per-account credential and a client-cloud deployment must never receive the
// reseller key.

const DEFAULT_BASE_URL = 'https://backend.omnidim.io/api/v1';
const PAGE_SIZE = 100;
const TIMEOUT_MS = 20_000;

export type OmniConfig = {
  /** The reseller (partner) key. */
  apiKey: string;
  baseUrl?: string;
  /** Per-child keys, by subAccountId, when the reseller key cannot read them. */
  childKeys?: Record<string, string>;
};

type OmniCallLog = {
  id: number;
  time_of_call?: string | null;
  call_duration_in_seconds?: number | null;
  call_duration_in_minutes?: number | null;
  call_status?: string | null;
  call_direction?: string | null;
  from_number?: string | null;
  to_number?: string | null;
  call_cost?: number | null;
  aggregated_estimated_cost?: number | null;
};

/**
 * Turn "05/04/2026 14:46:15" into an instant, and say whether we are sure.
 *
 * The format is DD/MM/YYYY as far as we can tell, but a value like 05/04 is
 * readable both ways and the two readings fall in different months. Rather than
 * pick one and be quietly wrong for eleven days of every month, this returns
 * `exact: false` whenever both readings are possible, and the reconciler
 * refuses to let such a run close a month.
 *
 * `timezone` is the child organisation's, as the provider reports it. Without
 * it a call just before midnight can land in the wrong day — and, once a month,
 * the wrong month.
 */
export function parseTimeOfCall(
  value: string | null | undefined,
  timezone: string | null | undefined,
): { at: Date; exact: boolean } | null {
  if (!value) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) {
    const iso = new Date(value);
    return Number.isNaN(iso.getTime()) ? null : { at: iso, exact: false };
  }
  const [, aRaw, bRaw, yRaw, hhRaw, mmRaw, ssRaw] = m;
  const a = Number(aRaw);
  const b = Number(bRaw);
  // Above 12 the field can only be a day, which settles the order.
  const exactOrder = a > 12 || b > 12;
  const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b]; // default DD/MM

  const at = new Date(
    Date.UTC(Number(yRaw), month - 1, day, Number(hhRaw), Number(mmRaw), Number(ssRaw)),
  );
  if (Number.isNaN(at.getTime())) return null;

  // A timezone we were not given is a timestamp we cannot place on the clock.
  // Treated as UTC so the record is still recorded, but never as exact.
  return { at, exact: exactOrder && Boolean(timezone) };
}

/** Parse a JSON response, turning a non-2xx into an error that names the call. */
async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    // Bounded: an HTML error page from a proxy would otherwise land in a log
    // line and in VoicePlatformAccount.lastError.
    const body = await res.text().catch(() => '');
    throw new Error(`omnidimension: ${what} failed (${res.status}) ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function directionOf(v: string | null | undefined): VoicePlatformCallRecord['direction'] {
  const s = (v ?? '').toLowerCase();
  if (s === 'inbound') return 'INBOUND';
  if (s === 'outbound') return 'OUTBOUND';
  return 'UNKNOWN';
}

export class OmniDimensionProvider implements VoicePlatformProvider {
  readonly name = 'omnidimension';
  // Their call records carry no modified timestamp and the listing takes no
  // date filter. Everything downstream branches on this.
  readonly supportsUpdatedSince = false;
  readonly supportsSpendCap = true;

  private readonly baseUrl: string;

  constructor(private readonly cfg: OmniConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Which key reads a child's call logs.
   *
   * One place, on purpose — see the warning in the header. Falls back to the
   * reseller key so the spike can find out which is right by changing nothing
   * but configuration.
   */
  private callsAuthFor(subAccountId: string): string {
    return this.cfg.childKeys?.[subAccountId] ?? this.cfg.apiKey;
  }

  private async get<T>(path: string, apiKey: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // Same SSRF discipline as every other outbound call in this codebase: the
    // base URL is configurable, so it has to be checked rather than trusted.
    await assertPublicUrl(url.toString());
    const res = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
      // Their listing is read-only and idempotent, so a throttle or a 5xx is
      // worth retrying rather than failing a whole reconciliation run over.
      retries: 2,
    });
    return readJson<T>(res, `GET ${path}`);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    await assertPublicUrl(url);
    // No retries: a credit transfer is not idempotent, and re-sending one that
    // actually succeeded would move a client's balance twice.
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
    });
    return readJson<T>(res, `POST ${path}`);
  }

  async listSubAccounts(): Promise<SubAccount[]> {
    const res = await this.get<{
      organizations?: {
        id?: number;
        name?: string;
        cost_per_min?: number;
        org_balance?: number;
        timezone?: string;
        concurrent_call_limit?: number;
      }[];
    }>('/reseller/organizations', this.cfg.apiKey);

    return (res.organizations ?? [])
      .filter((o) => o.id !== undefined)
      .map((o) => ({
        subAccountId: String(o.id),
        name: o.name ?? `Organization ${o.id}`,
        costPerMin: o.cost_per_min ?? null,
        balanceMinutes: o.org_balance ?? null,
        timezone: o.timezone ?? null,
        concurrentCallLimit: o.concurrent_call_limit ?? null,
      }));
  }

  async listCalls(args: {
    subAccountId: string;
    cursor?: string | null;
    stopAtSortKey?: number | null;
    pageSize?: number;
    timezone?: string | null;
  }): Promise<ListCallsPage> {
    const pageSize = args.pageSize ?? PAGE_SIZE;
    // The cursor is just the page number: with no date filter there is nothing
    // more expressive to carry.
    const pageno = args.cursor ? Number(args.cursor) : 1;

    const res = await this.get<{ call_log_data?: OmniCallLog[] }>(
      '/calls/logs',
      this.callsAuthFor(args.subAccountId),
      { pageno, pagesize: pageSize },
    );

    const raw = res.call_log_data ?? [];
    const records = raw.flatMap((log): VoicePlatformCallRecord[] => {
      if (log.id === undefined || log.id === null) return [];
      const parsed = parseTimeOfCall(log.time_of_call, args.timezone ?? null);
      const seconds = Math.max(0, Math.round(log.call_duration_in_seconds ?? 0));
      return [
        {
          externalId: String(log.id),
          sortKey: log.id,
          subAccountId: args.subAccountId,
          // A record we cannot date at all is stamped with now() and flagged
          // inexact. Dropping it would lose a billable minute; trusting it
          // would put that minute in an arbitrary month.
          occurredAt: parsed?.at ?? new Date(),
          occurredAtExact: parsed?.exact ?? false,
          billableSeconds: seconds,
          status: log.call_status ?? 'unknown',
          direction: directionOf(log.call_direction),
          fromNumber: log.from_number ?? null,
          toNumber: log.to_number ?? null,
          // `call_cost` is the billed figure; `aggregated_estimated_cost` is
          // their running estimate. Prefer the former and fall back.
          supplierCost: log.call_cost ?? log.aggregated_estimated_cost ?? null,
          supplierCurrency: null,
          raw: log,
        },
      ];
    });

    // A short page is the end of the listing; there is no total to compare to.
    const nextCursor = raw.length < pageSize ? null : String(pageno + 1);
    return { records, nextCursor };
  }

  async getCall(subAccountId: string, externalId: string): Promise<VoicePlatformCallRecord | null> {
    const res = await this.get<{ call_log_data?: OmniCallLog }>(
      `/calls/logs/${encodeURIComponent(externalId)}`,
      this.callsAuthFor(subAccountId),
    );
    const log = res.call_log_data;
    if (!log?.id) return null;
    const parsed = parseTimeOfCall(log.time_of_call, null);
    return {
      externalId: String(log.id),
      sortKey: log.id,
      subAccountId,
      occurredAt: parsed?.at ?? new Date(),
      occurredAtExact: parsed?.exact ?? false,
      billableSeconds: Math.max(0, Math.round(log.call_duration_in_seconds ?? 0)),
      status: log.call_status ?? 'unknown',
      direction: directionOf(log.call_direction),
      fromNumber: log.from_number ?? null,
      toNumber: log.to_number ?? null,
      supplierCost: log.call_cost ?? log.aggregated_estimated_cost ?? null,
      supplierCurrency: null,
      raw: log,
    };
  }

  /**
   * Move a child's balance to `minutes` worth of credit.
   *
   * Their API is a DELTA in both directions (`transfer` adds, `revert` removes)
   * rather than a set, so a caller that wants an absolute ceiling has to read
   * the current balance first. `setSpendCap` here takes the delta, and
   * src/lib/usage/spend-cap.ts owns the read-compute-apply.
   */
  async setSpendCap(args: {
    subAccountId: string;
    minutes: number;
    costPerMin?: number;
  }): Promise<{ balanceMinutes: number | null }> {
    const orgId = Number(args.subAccountId);
    const minutes = Math.round(args.minutes);
    if (minutes === 0) return { balanceMinutes: null };

    if (minutes > 0) {
      const res = await this.post<{ new_to_balance?: number }>('/reseller/credits/transfer', {
        to_organization_id: orgId,
        minutes,
        ...(args.costPerMin !== undefined ? { cost_per_min: args.costPerMin } : {}),
      });
      return { balanceMinutes: res.new_to_balance ?? null };
    }

    const res = await this.post<{ new_from_balance?: number }>('/reseller/credits/revert', {
      from_organization_id: orgId,
      minutes: Math.abs(minutes),
    });
    return { balanceMinutes: res.new_from_balance ?? null };
  }
}
