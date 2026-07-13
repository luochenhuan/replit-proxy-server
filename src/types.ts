/** Token usage for a single completed request. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Aggregated usage for one user+model pair. */
export interface UsageAggregate extends Usage {
  requests: number;
}

/**
 * A windowed limit. Requests are rejected once the user's consumption within
 * the trailing window reaches either cap. At least one cap must be set.
 */
export interface WindowLimit {
  windowSeconds: number;
  maxTokens?: number;
  maxRequests?: number;
}

/** Lifetime cap. Once total tokens ever consumed reach this, requests fail. */
export interface TotalLimit {
  maxTokens: number;
}

/**
 * Per-user limit configuration set by admins. All fields optional — absent
 * means unlimited on that axis.
 */
export interface LimitConfig {
  shortTerm?: WindowLimit;
  longTerm?: WindowLimit;
  total?: TotalLimit;
}

/** Result of a pre-request limit check. */
export type LimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Which limit tripped, e.g. "shortTerm" | "longTerm" | "total". */
      limit: keyof LimitConfig;
      /** Human-readable reason surfaced to the client. */
      reason: string;
      /** Seconds until the caller could plausibly retry (0 = never, for total). */
      retryAfterSeconds: number;
    };
