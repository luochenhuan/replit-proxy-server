import type { UsageAggregate, Usage } from "../types.js";

/**
 * Storage abstraction for usage accounting (billing + the usage API). The proxy
 * only ever talks to this interface, so the in-memory implementation below can
 * be swapped for a Redis/Postgres-backed one (for multi-instance deployments)
 * without touching any request-path code.
 *
 * Methods are synchronous by design: the hot path must not await I/O per
 * request. A distributed implementation would keep a local write-behind
 * buffer and reconcile asynchronously.
 *
 * Windowed rate-limit counters live separately in WindowCounterStore; this
 * store holds only per-model lifetime aggregates (for the cost/usage display),
 * so memory is O(users × models), independent of traffic volume.
 */
export interface UsageStore {
  /** Record a completed request's usage for a user. */
  record(userId: string, model: string, usage: Usage): void;

  /** Cumulative totals per model for a user (for the usage/cost display). */
  totalsByModel(userId: string): Map<string, UsageAggregate>;

  /** All user ids that have recorded usage (admin listing). */
  userIds(): string[];
}

interface UserUsage {
  byModel: Map<string, UsageAggregate>;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly users = new Map<string, UserUsage>();

  record(userId: string, model: string, usage: Usage): void {
    let user = this.users.get(userId);
    if (!user) {
      user = { byModel: new Map() };
      this.users.set(userId, user);
    }

    let agg = user.byModel.get(model);
    if (!agg) {
      agg = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
      user.byModel.set(model, agg);
    }
    agg.inputTokens += usage.inputTokens;
    agg.outputTokens += usage.outputTokens;
    agg.totalTokens += usage.totalTokens;
    agg.requests += 1;
  }

  totalsByModel(userId: string): Map<string, UsageAggregate> {
    const user = this.users.get(userId);
    if (!user) return new Map();
    // Return copies so callers can't mutate internal state.
    const out = new Map<string, UsageAggregate>();
    for (const [model, agg] of user.byModel) out.set(model, { ...agg });
    return out;
  }

  userIds(): string[] {
    return [...this.users.keys()];
  }
}
