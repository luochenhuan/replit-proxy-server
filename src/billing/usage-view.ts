import type { UsageStore } from "../store/usage-store.js";
import type { Pricing } from "./pricing.js";

/** Per-model usage plus its computed cost, shaped for the UI/API response. */
export interface ModelUsageView {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests: number;
  cost_usd: number;
}

export interface UsageView {
  user_id: string;
  models: Record<string, ModelUsageView>;
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    requests: number;
    cost_usd: number;
  };
}

/**
 * Build the usage-plus-cost view for a user. Shared by the user usage API and
 * the admin overview so cost math lives in exactly one place.
 */
export function buildUsageView(userId: string, usage: UsageStore, pricing: Pricing): UsageView {
  const byModel = usage.totalsByModel(userId);
  const models: Record<string, ModelUsageView> = {};
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    requests: 0,
    cost_usd: 0,
  };

  for (const [model, agg] of byModel) {
    const cost = pricing.cost(model, agg);
    models[model] = {
      input_tokens: agg.inputTokens,
      output_tokens: agg.outputTokens,
      total_tokens: agg.totalTokens,
      requests: agg.requests,
      cost_usd: round6(cost),
    };
    totals.input_tokens += agg.inputTokens;
    totals.output_tokens += agg.outputTokens;
    totals.total_tokens += agg.totalTokens;
    totals.requests += agg.requests;
    totals.cost_usd += cost;
  }
  totals.cost_usd = round6(totals.cost_usd);

  return { user_id: userId, models, totals };
}

/** Round to 6 decimal places (micro-dollar precision) to avoid float noise in JSON. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
