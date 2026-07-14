/**
 * Per-user call history — the data behind the "history of calls I've sent"
 * user UI and the admin drill-down.
 *
 * Each user gets a bounded ring buffer of their most recent calls, so memory
 * is O(users × capacity), never O(lifetime traffic). Lifetime totals for
 * billing live in UsageStore; this store is the recent detail view, not the
 * billing source of truth. A production deployment would stream these records
 * to a durable log/warehouse and keep only a hot recent window in memory —
 * exactly what this bounded buffer models.
 */
export type CallOutcome = "ok" | "rejected" | "error";

export interface CallRecord {
  /** Epoch millis at which the call completed (or was rejected). */
  at: number;
  model: string;
  streaming: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cost in USD for this call. Zero for rejected/error calls (nothing billed). */
  costUsd: number;
  outcome: CallOutcome;
  /** HTTP status returned to the client. */
  statusCode: number;
}

export interface CallHistoryStore {
  record(userId: string, call: CallRecord): void;
  /** Most recent calls first, capped at `limit`. */
  recent(userId: string, limit: number): CallRecord[];
  /** Total number of calls retained for a user (for pagination hints). */
  count(userId: string): number;
}

export class InMemoryCallHistoryStore implements CallHistoryStore {
  private readonly byUser = new Map<string, CallRecord[]>();

  constructor(private readonly capacityPerUser: number = 500) {}

  record(userId: string, call: CallRecord): void {
    let calls = this.byUser.get(userId);
    if (!calls) {
      calls = [];
      this.byUser.set(userId, calls);
    }
    calls.push(call);
    // Ring-buffer semantics: drop the oldest once over capacity.
    if (calls.length > this.capacityPerUser) calls.shift();
  }

  recent(userId: string, limit: number): CallRecord[] {
    const calls = this.byUser.get(userId);
    if (!calls) return [];
    // Sort by timestamp descending (newest first), then take `limit`. Insertion
    // order usually matches timestamp order for live traffic, but not when
    // records are backfilled with arbitrary `at` values, so sort explicitly.
    return [...calls].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.length ?? 0;
  }
}
