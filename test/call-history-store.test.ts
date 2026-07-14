import { describe, expect, it } from "vitest";
import { InMemoryCallHistoryStore, type CallRecord } from "../src/store/call-history-store.js";

function call(at: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    at,
    model: "m",
    streaming: false,
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    costUsd: 0.001,
    outcome: "ok",
    statusCode: 200,
    ...overrides,
  };
}

describe("InMemoryCallHistoryStore", () => {
  it("returns calls newest-first", () => {
    const store = new InMemoryCallHistoryStore();
    store.record("u1", call(1000));
    store.record("u1", call(2000));
    store.record("u1", call(3000));
    const recent = store.recent("u1", 10);
    expect(recent.map((c) => c.at)).toEqual([3000, 2000, 1000]);
  });

  it("sorts by timestamp descending even when recorded out of order", () => {
    const store = new InMemoryCallHistoryStore();
    store.record("u1", call(2000));
    store.record("u1", call(1000));
    store.record("u1", call(3000));
    expect(store.recent("u1", 10).map((c) => c.at)).toEqual([3000, 2000, 1000]);
  });

  it("caps the returned count at the limit", () => {
    const store = new InMemoryCallHistoryStore();
    for (let i = 0; i < 10; i++) store.record("u1", call(i));
    expect(store.recent("u1", 3).map((c) => c.at)).toEqual([9, 8, 7]);
  });

  it("evicts oldest calls beyond capacity (ring buffer)", () => {
    const store = new InMemoryCallHistoryStore(3);
    for (let i = 0; i < 5; i++) store.record("u1", call(i));
    expect(store.count("u1")).toBe(3);
    // Oldest two (0, 1) evicted; 4,3,2 remain newest-first.
    expect(store.recent("u1", 10).map((c) => c.at)).toEqual([4, 3, 2]);
  });

  it("isolates users", () => {
    const store = new InMemoryCallHistoryStore();
    store.record("u1", call(1000));
    expect(store.recent("u2", 10)).toEqual([]);
    expect(store.count("u2")).toBe(0);
  });

  it("preserves rejected and error outcomes", () => {
    const store = new InMemoryCallHistoryStore();
    store.record("u1", call(1000, { outcome: "rejected", statusCode: 429, costUsd: 0, totalTokens: 0 }));
    const [rec] = store.recent("u1", 1);
    expect(rec!.outcome).toBe("rejected");
    expect(rec!.costUsd).toBe(0);
  });
});
