import { describe, expect, it } from "vitest";
import { InMemoryUsageStore } from "../src/store/usage-store.js";

function usage(total: number) {
  return { inputTokens: Math.floor(total / 2), outputTokens: Math.ceil(total / 2), totalTokens: total };
}

describe("InMemoryUsageStore", () => {
  it("aggregates lifetime usage per model", () => {
    const store = new InMemoryUsageStore();
    store.record("u1", "llama3.2:1b", usage(100));
    store.record("u1", "llama3.2:1b", usage(50));
    store.record("u1", "moondream", usage(30));

    const byModel = store.totalsByModel("u1");
    expect(byModel.get("llama3.2:1b")).toMatchObject({ totalTokens: 150, requests: 2 });
    expect(byModel.get("moondream")).toMatchObject({ totalTokens: 30, requests: 1 });
  });

  it("splits prompt and completion tokens in aggregates", () => {
    const store = new InMemoryUsageStore();
    store.record("u1", "m", { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    store.record("u1", "m", { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    expect(store.totalsByModel("u1").get("m")).toEqual({
      inputTokens: 15,
      outputTokens: 25,
      totalTokens: 40,
      requests: 2,
    });
  });

  it("isolates users", () => {
    const store = new InMemoryUsageStore();
    store.record("u1", "m", usage(100));
    expect(store.totalsByModel("u2").size).toBe(0);
  });

  it("returns defensive copies of aggregates", () => {
    const store = new InMemoryUsageStore();
    store.record("u1", "m", usage(100));
    const copy = store.totalsByModel("u1").get("m")!;
    copy.totalTokens = 0;
    expect(store.totalsByModel("u1").get("m")!.totalTokens).toBe(100);
  });

  it("lists users that have recorded usage", () => {
    const store = new InMemoryUsageStore();
    store.record("u1", "m", usage(1));
    store.record("u2", "m", usage(1));
    expect(store.userIds().sort()).toEqual(["u1", "u2"]);
  });
});
