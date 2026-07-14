import type { FastifyInstance } from "fastify";
import type { UsageStore } from "../store/usage-store.js";
import type { LimitStore } from "../store/limit-store.js";
import type { CallHistoryStore } from "../store/call-history-store.js";
import type { Pricing } from "../billing/pricing.js";
import type { Limiter } from "../limits/limiter.js";
import { buildUsageView } from "../billing/usage-view.js";
import { serializeCalls } from "./call-serializer.js";

/** Max call-history rows returned in one request. */
const HISTORY_LIMIT = 200;

/**
 * User-facing usage + history API. Authenticated with the same bearer token
 * used for completions; a user can only ever see their own data.
 */
export function registerUsageRoutes(
  app: FastifyInstance,
  usage: UsageStore,
  limits: LimitStore,
  history: CallHistoryStore,
  pricing: Pricing,
  limiter: Limiter,
): void {
  app.get("/v1/usage", async (req) => {
    const userId = req.userId!;
    const view = buildUsageView(userId, usage, pricing);
    // Live consumption within each configured rate-limit window, so the
    // dashboard gauges reflect actual usage rather than always reading zero.
    const windows = limiter.windowUsage(userId).map((w) => ({
      window: w.key,
      window_seconds: w.windowSeconds,
      tokens: w.tokens,
      requests: w.requests,
      max_tokens: w.maxTokens ?? null,
      max_requests: w.maxRequests ?? null,
    }));
    return { ...view, limits: limits.get(userId) ?? null, window_usage: windows };
  });

  app.get("/v1/history", async (req) => {
    const userId = req.userId!;
    return {
      user_id: userId,
      calls: serializeCalls(history.recent(userId, HISTORY_LIMIT)),
      total_retained: history.count(userId),
    };
  });
}
