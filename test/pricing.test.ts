import { describe, expect, it } from "vitest";
import { Pricing } from "../src/billing/pricing.js";

describe("Pricing", () => {
  it("computes split prompt/completion cost per model", () => {
    const pricing = new Pricing({ "m": { inputPerMillion: 10, outputPerMillion: 30 } });
    // 1M prompt @ $10 + 1M completion @ $30 = $40.
    const cost = pricing.cost("m", { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
    expect(cost).toBeCloseTo(40, 6);
  });

  it("falls back to a default price for unknown models so cost is never silently zero", () => {
    const pricing = new Pricing({});
    const cost = pricing.cost("mystery", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    expect(cost).toBeGreaterThan(0);
  });

  it("scales linearly with token counts", () => {
    const pricing = new Pricing({ "m": { inputPerMillion: 1, outputPerMillion: 1 } });
    const small = pricing.cost("m", { inputTokens: 100, outputTokens: 100, totalTokens: 200 });
    const big = pricing.cost("m", { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 });
    expect(big).toBeCloseTo(small * 10, 9);
  });

  it("exposes the price sheet for display", () => {
    const pricing = new Pricing({ "a": { inputPerMillion: 1, outputPerMillion: 2 } });
    expect(pricing.entries()).toEqual([{ model: "a", inputPerMillion: 1, outputPerMillion: 2 }]);
  });
});
