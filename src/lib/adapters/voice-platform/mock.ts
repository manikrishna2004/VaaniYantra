import type {
  ListCallsPage,
  SubAccount,
  VoicePlatformCallRecord,
  VoicePlatformProvider,
} from '@/lib/adapters/voice-platform/types';

// An in-memory voice platform, for tests and for local development against
// USE_MOCK_VOICE_PLATFORM=true. Mirrors the mock telephony adapter's role.
//
// It deliberately reproduces the two things about the real provider that the
// reconciler has to survive: pages come back NEWEST FIRST, and a call's
// duration can be revised after the fact.

export class MockVoicePlatform implements VoicePlatformProvider {
  readonly name = 'mock';
  readonly supportsUpdatedSince = false;
  readonly supportsSpendCap = true;

  private accounts = new Map<string, SubAccount>();
  private calls = new Map<string, VoicePlatformCallRecord[]>();
  /** Every setSpendCap delta applied, so tests can assert on them. */
  readonly capCalls: { subAccountId: string; minutes: number }[] = [];

  constructor(accounts: SubAccount[] = []) {
    for (const a of accounts) this.accounts.set(a.subAccountId, a);
  }

  seedAccount(a: SubAccount) {
    this.accounts.set(a.subAccountId, a);
  }

  /** Add or REPLACE a call, by externalId — replacing is how a revision is simulated. */
  seedCall(rec: VoicePlatformCallRecord) {
    const list = this.calls.get(rec.subAccountId) ?? [];
    const at = list.findIndex((c) => c.externalId === rec.externalId);
    if (at >= 0) list[at] = rec;
    else list.push(rec);
    this.calls.set(rec.subAccountId, list);
  }

  async listSubAccounts(): Promise<SubAccount[]> {
    return [...this.accounts.values()];
  }

  async listCalls(args: {
    subAccountId: string;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<ListCallsPage> {
    const pageSize = args.pageSize ?? 100;
    const page = args.cursor ? Number(args.cursor) : 1;
    // Newest first, exactly as the real listing behaves.
    const all = [...(this.calls.get(args.subAccountId) ?? [])].sort((a, b) => b.sortKey - a.sortKey);
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return { records: slice, nextCursor: slice.length < pageSize ? null : String(page + 1) };
  }

  async getCall(subAccountId: string, externalId: string): Promise<VoicePlatformCallRecord | null> {
    return (this.calls.get(subAccountId) ?? []).find((c) => c.externalId === externalId) ?? null;
  }

  async setSpendCap(args: { subAccountId: string; minutes: number }): Promise<{ balanceMinutes: number | null }> {
    this.capCalls.push({ subAccountId: args.subAccountId, minutes: args.minutes });
    const acct = this.accounts.get(args.subAccountId);
    if (!acct) return { balanceMinutes: null };
    acct.balanceMinutes = (acct.balanceMinutes ?? 0) + args.minutes;
    return { balanceMinutes: acct.balanceMinutes };
  }
}
