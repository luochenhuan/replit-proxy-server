import type { LimitConfig } from "../types.js";

/**
 * Storage abstraction for admin-configured limits, mirroring UsageStore's
 * swap-for-distributed design.
 */
export interface LimitStore {
  get(userId: string): LimitConfig | undefined;
  set(userId: string, config: LimitConfig): void;
  delete(userId: string): boolean;
  entries(): Array<{ userId: string; config: LimitConfig }>;
}

export class InMemoryLimitStore implements LimitStore {
  private readonly limits = new Map<string, LimitConfig>();

  get(userId: string): LimitConfig | undefined {
    return this.limits.get(userId);
  }

  set(userId: string, config: LimitConfig): void {
    this.limits.set(userId, config);
  }

  delete(userId: string): boolean {
    return this.limits.delete(userId);
  }

  entries(): Array<{ userId: string; config: LimitConfig }> {
    return [...this.limits.entries()].map(([userId, config]) => ({ userId, config }));
  }
}
