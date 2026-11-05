// Voice platform adapter — a whole voice PLATFORM we resell, not a carrier.
//
// Deliberately a separate interface from src/lib/adapters/telephony/types.ts.
// A TelephonyProvider sells us a phone number and a media stream; a
// VoicePlatformProvider runs the agent as well, bills us per minute, and holds
// the sub-accounts we resell to clients. Folding the two together would give
// one interface where half the methods throw for half the implementations.
//
// Same capability-flag style as the telephony adapters, for the same reason:
// routes and pollers branch on a flag rather than try/catching an unsupported
// operation.

/** One call as the provider reports it. */
export type VoicePlatformCallRecord = {
  /** The provider's own id. Becomes UsageEvent.externalId. */
  externalId: string;
  /**
   * Monotonic ordering key for pagination.
   *
   * Not every provider gives one, but where the API has no date filter — which
   * is the case today — this is the only way to page from "newest" back to
   * "already seen" without re-reading the entire history every run.
   */
  sortKey: number;
  subAccountId: string;
  /** When the call happened, resolved to a real instant. See `occurredAtExact`. */
  occurredAt: Date;
  /**
   * False when `occurredAt` had to be inferred — an ambiguous local timestamp,
   * a missing timezone. The reconciler still records the call, but a run with
   * inexact timestamps must never be trusted to CLOSE a month, because the
   * inference decides which month a minute is billed in.
   */
  occurredAtExact: boolean;
  /** What the provider will invoice us for, in seconds. */
  billableSeconds: number;
  status: string;
  direction: 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';
  fromNumber?: string | null;
  toNumber?: string | null;
  /** Their cost to us for this call, in the provider's currency. */
  supplierCost?: number | null;
  supplierCurrency?: string | null;
  /** The provider's record, verbatim — the evidence behind a disputed minute. */
  raw: unknown;
};

export type ListCallsPage = {
  records: VoicePlatformCallRecord[];
  /** Opaque token for the next page, or null when the listing is exhausted. */
  nextCursor: string | null;
};

/** A child organisation we hold on the provider, as it reports it. */
export type SubAccount = {
  subAccountId: string;
  name: string;
  /** What the provider charges us per minute for this child. */
  costPerMin: number | null;
  /**
   * Remaining balance, in MINUTES. This is the prepaid ceiling that actually
   * bites: it is enforced upstream, on infrastructure the client has no root
   * on, which is the only place a spend cap survives a client-cloud deployment.
   */
  balanceMinutes: number | null;
  /** The child's timezone. Decides which month an ambiguous timestamp lands in. */
  timezone: string | null;
  concurrentCallLimit?: number | null;
};

export interface VoicePlatformProvider {
  readonly name: string;

  /**
   * Whether `listCalls` can filter on when a record was last MODIFIED.
   *
   * False for OmniDimension: `/calls/logs` accepts only pageno, pagesize,
   * agentid, call_status and bulk_call_id, and a call record carries no
   * updated-at field at all. That single flag is why the reconciler needs a
   * month-end full re-pull — with it false, a correction to an older call is
   * invisible until the whole month is read again.
   */
  readonly supportsUpdatedSince: boolean;

  /** Whether we can raise or lower a child's spend ceiling through the API. */
  readonly supportsSpendCap: boolean;

  /** Every child organisation under our reseller account. */
  listSubAccounts(): Promise<SubAccount[]>;

  /**
   * One page of call records for a sub-account, newest first.
   *
   * `stopAtSortKey` lets the caller say "I already hold everything at or below
   * this", so a routine poll reads one page instead of the whole history.
   * Implementations must still return the page they fetched; the reconciler
   * decides when to stop.
   */
  listCalls(args: {
    subAccountId: string;
    cursor?: string | null;
    stopAtSortKey?: number | null;
    pageSize?: number;
  }): Promise<ListCallsPage>;

  /** A single record, for re-reading one call during a dispute. */
  getCall(subAccountId: string, externalId: string): Promise<VoicePlatformCallRecord | null>;

  /**
   * Move minutes onto a child's balance. Positive tops up, negative claws back.
   *
   * This is how a prepaid wallet becomes enforceable rather than advisory: the
   * client's balance here is the ceiling, and it is applied by the provider
   * rather than by a gate in our own process that a client-cloud install could
   * be patched to ignore.
   */
  setSpendCap?(args: {
    subAccountId: string;
    minutes: number;
    costPerMin?: number;
  }): Promise<{ balanceMinutes: number | null }>;
}
