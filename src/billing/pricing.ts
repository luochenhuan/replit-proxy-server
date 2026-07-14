import type { Usage } from "../types.js";

/**
 * Token pricing.
 *
 * The prompt states "LLM token cost is passed to users as-is", so billing is a
 * pure function of token counts and a per-model price sheet. Prices are quoted
 * in USD per 1,000,000 tokens (the industry convention), split by input vs.
 * output because real providers charge output tokens at a premium.
 *
 * The rates below are OpenAI's published GPT-5 family pricing
 * (https://developers.openai.com/api/docs/pricing). Ollama itself is free to
 * run locally, so the local models are mapped onto representative GPT-5 tiers
 * (llama3.2:1b -> nano, moondream -> mini) so the billing UI shows realistic
 * dollar figures. A production system would load this sheet from config or a
 * pricing service — the shape here is exactly what that would return.
 */
export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
}

const PRICE_SHEET: Record<string, ModelPrice> = {
  // OpenAI GPT-5 family (published rates, USD per 1M tokens).
  "gpt-5.5": { inputPerMillion: 5.0, outputPerMillion: 30.0 },
  "gpt-5.5-pro": { inputPerMillion: 30.0, outputPerMillion: 180.0 },
  "gpt-5.4": { inputPerMillion: 2.5, outputPerMillion: 15.0 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "gpt-5.4-pro": { inputPerMillion: 30.0, outputPerMillion: 180.0 },
  // Local Ollama models, mapped onto representative GPT-5 tiers.
  "llama3.2:1b": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  moondream: { inputPerMillion: 0.75, outputPerMillion: 4.5 },
};

/** Fallback for models with no explicit entry, so cost is never silently zero. */
const DEFAULT_PRICE: ModelPrice = { inputPerMillion: 2.5, outputPerMillion: 15.0 };

export class Pricing {
  constructor(private readonly sheet: Record<string, ModelPrice> = PRICE_SHEET) {}

  priceFor(model: string): ModelPrice {
    return this.sheet[model] ?? DEFAULT_PRICE;
  }

  /** Cost in USD for one request's usage against the given model. */
  cost(model: string, usage: Usage): number {
    const price = this.priceFor(model);
    return (
      (usage.inputTokens * price.inputPerMillion +
        usage.outputTokens * price.outputPerMillion) /
      1_000_000
    );
  }

  /** The full sheet, for display in the UI. */
  entries(): Array<{ model: string } & ModelPrice> {
    return Object.entries(this.sheet).map(([model, price]) => ({ model, ...price }));
  }
}
