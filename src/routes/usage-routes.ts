import type { FastifyInstance } from "fastify";
import type { UsageStore } from "../store/usage-store.js";
import type { LimitStore } from "../store/limit-store.js";

/**
 * User-facing usage API. Authenticated with the same bearer token used for
 * completions; a user can only ever see their own usage.
 */
export function registerUsageRoutes(
  app: FastifyInstance,
  usage: UsageStore,
  limits: LimitStore,
): void {
  app.get("/v1/usage", async (req) => {
    const userId = req.userId!;
    const byModel = usage.totalsByModel(userId);

    const models: Record<
      string,
      { prompt_tokens: number; completion_tokens: number; total_tokens: number; requests: number }
    > = {};
    let promptTotal = 0;
    let completionTotal = 0;
    let requestsTotal = 0;
    for (const [model, agg] of byModel) {
      models[model] = {
        prompt_tokens: agg.promptTokens,
        completion_tokens: agg.completionTokens,
        total_tokens: agg.totalTokens,
        requests: agg.requests,
      };
      promptTotal += agg.promptTokens;
      completionTotal += agg.completionTokens;
      requestsTotal += agg.requests;
    }

    return {
      user_id: userId,
      models,
      totals: {
        prompt_tokens: promptTotal,
        completion_tokens: completionTotal,
        total_tokens: usage.totalTokens(userId),
        requests: requestsTotal,
      },
      limits: limits.get(userId) ?? null,
    };
  });
}
