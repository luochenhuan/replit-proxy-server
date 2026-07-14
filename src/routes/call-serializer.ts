import type { CallRecord } from "../store/call-history-store.js";

/** JSON shape of a call record for API responses (snake_case, ISO timestamp). */
export function serializeCalls(calls: CallRecord[]) {
  return calls.map((c) => ({
    at: new Date(c.at).toISOString(),
    model: c.model,
    streaming: c.streaming,
    input_tokens: c.inputTokens,
    output_tokens: c.outputTokens,
    total_tokens: c.totalTokens,
    cost_usd: c.costUsd,
    outcome: c.outcome,
    status_code: c.statusCode,
  }));
}
