import { describe, expect, it } from "vitest";
import { InMemoryLimitStore } from "../src/store/limit-store.js";
import { InMemoryWindowCounterStore } from "../src/store/window-counter-store.js";
import { Limiter, LimitValidationError, validateLimitConfig } from "../src/limits/limiter.js";

function setup() {
  const limits = new InMemoryLimitStore();
  const windows = new InMemoryWindowCounterStore();
  const limiter = new Limiter(limits, windows);
  return { limits, windows, limiter };
}

function tokens(total: number) {
  return { inputTokens: 0, outputTokens: total, totalTokens: total };
}

/** Simulate a completed request: advance the limiter's window counters. */
function completeRequest(
  ctx: ReturnType<typeof setup>,
  userId: string,
  total: number,
  at: number,
) {
  ctx.limiter.record(userId, tokens(total), at);
}

describe("Limiter", () => {
  it("allows users with no configured limits", () => {
    const ctx = setup();
    expect(ctx.limiter.check("nobody").allowed).toBe(true);
  });

  it("enforces short-term request-count limits and recovers when the window resets", () => {
    const ctx = setup();
    ctx.limits.set("u1", { shortTerm: { windowSeconds: 10, maxRequests: 2 } });

    completeRequest(ctx, "u1", 1, 1000);
    completeRequest(ctx, "u1", 1, 2000);
    expect(ctx.limiter.check("u1", 3000).allowed).toBe(false);

    // Fixed window anchored at the first request (t=1s) expires at t=11s.
    expect(ctx.limiter.check("u1", 10_999).allowed).toBe(false);
    expect(ctx.limiter.check("u1", 11_000).allowed).toBe(true);
  });

  it("reports an exact retry-after based on the window start", () => {
    const ctx = setup();
    ctx.limits.set("u1", { shortTerm: { windowSeconds: 60, maxRequests: 1 } });
    completeRequest(ctx, "u1", 1, 10_000); // window [10s, 70s)

    const decision = ctx.limiter.check("u1", 25_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterSeconds).toBe(45); // 70s - 25s
  });

  it("enforces window token limits", () => {
    const ctx = setup();
    ctx.limits.set("u1", { longTerm: { windowSeconds: 3600, maxTokens: 500 } });

    completeRequest(ctx, "u1", 499, 1000);
    expect(ctx.limiter.check("u1", 2000).allowed).toBe(true);
    completeRequest(ctx, "u1", 2, 2000);
    expect(ctx.limiter.check("u1", 3000).allowed).toBe(false);
  });

  it("only counts usage recorded while a window limit is configured", () => {
    const ctx = setup();
    // Usage happens before any limit exists…
    completeRequest(ctx, "u1", 1000, 1000);
    // …then the admin adds a window limit: prior usage is not back-counted.
    ctx.limits.set("u1", { shortTerm: { windowSeconds: 60, maxTokens: 500 } });
    expect(ctx.limiter.check("u1", 2000).allowed).toBe(true);
  });

  it("reports shortTerm as the first limit that trips when both windows are configured", () => {
    const ctx = setup();
    ctx.limits.set("u1", {
      shortTerm: { windowSeconds: 10, maxRequests: 1 },
      longTerm: { windowSeconds: 100, maxRequests: 100 },
    });
    completeRequest(ctx, "u1", 10, 1000);
    // shortTerm (checked first) is at its cap; longTerm has headroom.
    const decision = ctx.limiter.check("u1", 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.limit).toBe("shortTerm");
  });

  it("tracks short-term and long-term windows independently", () => {
    const ctx = setup();
    ctx.limits.set("u1", {
      shortTerm: { windowSeconds: 10, maxRequests: 5 },
      longTerm: { windowSeconds: 100, maxRequests: 3 },
    });
    completeRequest(ctx, "u1", 1, 1000);
    completeRequest(ctx, "u1", 1, 2000);
    completeRequest(ctx, "u1", 1, 3000);

    // Short-term (5) not hit, but long-term (3) is.
    const decision = ctx.limiter.check("u1", 4000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.limit).toBe("longTerm");

    // Short-term window resets at t=11s, but long-term still blocks.
    expect(ctx.limiter.check("u1", 12_000).allowed).toBe(false);
    // Long-term window resets at t=101s.
    expect(ctx.limiter.check("u1", 101_000).allowed).toBe(true);
  });
});

describe("validateLimitConfig", () => {
  it("accepts a full valid config", () => {
    const config = validateLimitConfig({
      shortTerm: { windowSeconds: 60, maxRequests: 10 },
      longTerm: { windowSeconds: 3600, maxTokens: 100_000 },
    });
    expect(config.shortTerm?.maxRequests).toBe(10);
    expect(config.longTerm?.maxTokens).toBe(100_000);
  });

  it("rejects empty configs", () => {
    expect(() => validateLimitConfig({})).toThrow(LimitValidationError);
  });

  it("rejects windows with no caps", () => {
    expect(() => validateLimitConfig({ shortTerm: { windowSeconds: 60 } })).toThrow(
      LimitValidationError,
    );
  });

  it("rejects non-positive numbers", () => {
    expect(() =>
      validateLimitConfig({ shortTerm: { windowSeconds: -5, maxRequests: 10 } }),
    ).toThrow(LimitValidationError);
    expect(() => validateLimitConfig({ longTerm: { windowSeconds: 60, maxTokens: 0 } })).toThrow(
      LimitValidationError,
    );
  });

  it("rejects shortTerm window >= longTerm window", () => {
    expect(() =>
      validateLimitConfig({
        shortTerm: { windowSeconds: 3600, maxRequests: 1 },
        longTerm: { windowSeconds: 60, maxRequests: 1 },
      }),
    ).toThrow(LimitValidationError);
  });
});
