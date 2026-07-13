import type { UsageAggregate, Usage } from "../types.js";

/**
 * Storage abstraction for usage accounting (billing + the usage API + the
 * lifetime total cap). The proxy only ever talks to this interface, so the
 * in-memory implementation below can be swapped for a Redis/Postgres-backed
 * one (for multi-instance deployments) without touching any request-path
 * code.
 *
 * Methods are synchronous by design: the hot path must not await I/O per
 * request. A distributed implementation would keep a local write-behind
 * buffer and reconcile asynchronously.
 *
 * Windowed rate-limit counters live separately in WindowCounterStore; this
 * store holds only lifetime aggregates, so memory is O(users × models),
 * independent of traffic volume.
 */
export interface UsageStore {
  /** Record a completed request's usage for a user. */
  record(userId: string, model: string, usage: Usage): void;

  /** Lifetime totals per model for a user. */
  totalsByModel(userId: string): Map<string, UsageAggregate>;

  /** Lifetime total tokens across all models. */
  totalTokens(userId: string): number;

  /** All user ids that have recorded usage (admin listing). */
  userIds(): string[];
}

interface UserUsage {
  byModel: Map<string, UsageAggregate>;
  totalTokens: number;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly users = new Map<string, UserUsage>();

  record(userId: string, model: string, usage: Usage): void {
    let user = this.users.get(userId);
    if (!user) {
      user = { byModel: new Map(), totalTokens: 0 };
      this.users.set(userId, user);
    }

    let agg = user.byModel.get(model);
    if (!agg) {
      agg = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
      user.byModel.set(model, agg);
    }
    agg.promptTokens += usage.promptTokens;
    agg.completionTokens += usage.completionTokens;
    agg.totalTokens += usage.totalTokens;
    agg.requests += 1;
    user.totalTokens += usage.totalTokens;
  }

  totalsByModel(userId: string): Map<string, UsageAggregate> {
    const user = this.users.get(userId);
    if (!user) return new Map();
    // Return copies so callers can't mutate internal state.
    const out = new Map<string, UsageAggregate>();
    for (const [model, agg] of user.byModel) out.set(model, { ...agg });
    return out;
  }

  totalTokens(userId: string): number {
    return this.users.get(userId)?.totalTokens ?? 0;
  }

  userIds(): string[] {
    return [...this.users.keys()];
  }
}
