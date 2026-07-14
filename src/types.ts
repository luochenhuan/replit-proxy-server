/** Token usage for a single completed request. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
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

/**
 * Per-user limit configuration set by admins. All fields optional — absent
 * means unlimited on that axis. Limits are windowed (rate limits); there is no
 * lifetime cap, so usage is never permanently exhausted.
 */
export interface LimitConfig {
  shortTerm?: WindowLimit;
  longTerm?: WindowLimit;
}

/** Result of a pre-request limit check. */
export type LimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Which limit tripped: "shortTerm" | "longTerm". */
      limit: keyof LimitConfig;
      /** Human-readable reason surfaced to the client. */
      reason: string;
      /** Seconds until the caller could retry. */
      retryAfterSeconds: number;
    };
