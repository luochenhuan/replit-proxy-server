import type { LimitConfig, LimitDecision, Usage, WindowLimit } from "../types.js";
import type { LimitStore } from "../store/limit-store.js";
import type { UsageStore } from "../store/usage-store.js";
import type { WindowCounterStore } from "../store/window-counter-store.js";

/**
 * Enforces admin-configured limits.
 *
 * Windowed limits use staggered fixed-window counters (see
 * window-counter-store.ts); total limits read the lifetime aggregate from the
 * usage store. `record` must be called once per completed request so the
 * window counters advance — the proxy does this alongside usage recording.
 *
 * Design decision: limits are checked BEFORE forwarding a request, against
 * usage that has already been recorded. Token counts are only known after a
 * request completes, so a user can overshoot a token cap by at most one
 * request's worth of tokens — the same trade-off OpenAI and most metered
 * APIs make. The alternative (pre-reserving an estimate) rejects legitimate
 * traffic on bad estimates and adds a reconciliation step (LiteLLM ships
 * this and its issue tracker shows keys throttled at 60-90% of their limit
 * from over-estimation); overshoot-by-one is simpler and bounded.
 *
 * Request-count limits have no such slack: the Nth+1 request in a window is
 * rejected exactly.
 */
export class Limiter {
  constructor(
    private readonly limits: LimitStore,
    private readonly usage: UsageStore,
    private readonly windows: WindowCounterStore,
  ) {}

  check(userId: string, now: number = Date.now()): LimitDecision {
    const config = this.limits.get(userId);
    if (!config) return { allowed: true };

    if (config.total) {
      const total = this.usage.totalTokens(userId);
      if (total >= config.total.maxTokens) {
        return {
          allowed: false,
          limit: "total",
          reason: `Total usage limit reached (${total}/${config.total.maxTokens} tokens). Contact support to raise your limit.`,
          retryAfterSeconds: 0,
        };
      }
    }

    for (const key of ["shortTerm", "longTerm"] as const) {
      const window = config[key];
      if (!window) continue;
      const decision = this.checkWindow(userId, key, window, now);
      if (decision) return decision;
    }

    return { allowed: true };
  }

  /**
   * Advance window counters for a completed request. Only windows currently
   * configured for the user are counted; usage incurred while no limit is set
   * is deliberately not back-counted against a limit added later.
   */
  record(userId: string, usage: Usage, now: number = Date.now()): void {
    const config = this.limits.get(userId);
    if (!config) return;
    for (const key of ["shortTerm", "longTerm"] as const) {
      const window = config[key];
      if (!window) continue;
      this.windows.add(userId, key, window.windowSeconds, usage.totalTokens, now);
    }
  }

  private checkWindow(
    userId: string,
    key: "shortTerm" | "longTerm",
    limit: WindowLimit,
    now: number,
  ): LimitDecision | undefined {
    const counter = this.windows.peek(userId, key, limit.windowSeconds, now);

    // Exact hint: the counter resets windowSeconds after the window started.
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((counter.windowStartMs + limit.windowSeconds * 1000 - now) / 1000),
    );

    if (limit.maxRequests !== undefined && counter.requests >= limit.maxRequests) {
      return {
        allowed: false,
        limit: key,
        reason: `Rate limit exceeded: ${counter.requests}/${limit.maxRequests} requests in ${limit.windowSeconds}s window.`,
        retryAfterSeconds,
      };
    }
    if (limit.maxTokens !== undefined && counter.tokens >= limit.maxTokens) {
      return {
        allowed: false,
        limit: key,
        reason: `Rate limit exceeded: ${counter.tokens}/${limit.maxTokens} tokens in ${limit.windowSeconds}s window.`,
        retryAfterSeconds,
      };
    }
    return undefined;
  }
}

/** Validation for admin-supplied limit configs. Throws with a client-safe message. */
export function validateLimitConfig(raw: unknown): LimitConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LimitValidationError("Body must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const config: LimitConfig = {};

  for (const key of ["shortTerm", "longTerm"] as const) {
    if (obj[key] === undefined || obj[key] === null) continue;
    config[key] = validateWindow(key, obj[key]);
  }
  if (obj.total !== undefined && obj.total !== null) {
    const total = obj.total as Record<string, unknown>;
    if (!isPositiveInt(total.maxTokens)) {
      throw new LimitValidationError("total.maxTokens must be a positive integer.");
    }
    config.total = { maxTokens: total.maxTokens };
  }

  if (!config.shortTerm && !config.longTerm && !config.total) {
    throw new LimitValidationError(
      "At least one of shortTerm, longTerm, or total must be provided.",
    );
  }
  if (
    config.shortTerm &&
    config.longTerm &&
    config.shortTerm.windowSeconds >= config.longTerm.windowSeconds
  ) {
    throw new LimitValidationError("shortTerm window must be shorter than longTerm window.");
  }
  return config;
}

function validateWindow(name: string, raw: unknown): WindowLimit {
  if (typeof raw !== "object" || raw === null) {
    throw new LimitValidationError(`${name} must be an object.`);
  }
  const obj = raw as Record<string, unknown>;
  if (!isPositiveInt(obj.windowSeconds)) {
    throw new LimitValidationError(`${name}.windowSeconds must be a positive integer.`);
  }
  const window: WindowLimit = { windowSeconds: obj.windowSeconds };
  if (obj.maxTokens !== undefined) {
    if (!isPositiveInt(obj.maxTokens)) {
      throw new LimitValidationError(`${name}.maxTokens must be a positive integer.`);
    }
    window.maxTokens = obj.maxTokens;
  }
  if (obj.maxRequests !== undefined) {
    if (!isPositiveInt(obj.maxRequests)) {
      throw new LimitValidationError(`${name}.maxRequests must be a positive integer.`);
    }
    window.maxRequests = obj.maxRequests;
  }
  if (window.maxTokens === undefined && window.maxRequests === undefined) {
    throw new LimitValidationError(`${name} must set maxTokens and/or maxRequests.`);
  }
  return window;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export class LimitValidationError extends Error {}
