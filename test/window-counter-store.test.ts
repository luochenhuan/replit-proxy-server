import { describe, expect, it } from "vitest";
import { InMemoryWindowCounterStore } from "../src/store/window-counter-store.js";

describe("InMemoryWindowCounterStore", () => {
  it("accumulates within an active window", () => {
    const store = new InMemoryWindowCounterStore();
    store.add("u1", "shortTerm", 60, 100, 1000);
    store.add("u1", "shortTerm", 60, 50, 30_000);

    const counter = store.peek("u1", "shortTerm", 60, 59_000);
    expect(counter).toMatchObject({ tokens: 150, requests: 2, windowStartMs: 1000 });
  });

  it("staggers the window start to the first add, not clock alignment", () => {
    const store = new InMemoryWindowCounterStore();
    // First usage at t=45.5s: window runs [45.5s, 105.5s), not [0s, 60s).
    store.add("u1", "shortTerm", 60, 10, 45_500);
    expect(store.peek("u1", "shortTerm", 60, 100_000).requests).toBe(1); // still inside
    expect(store.peek("u1", "shortTerm", 60, 105_500).requests).toBe(0); // expired exactly at start+60s
  });

  it("resets lazily after the window elapses", () => {
    const store = new InMemoryWindowCounterStore();
    store.add("u1", "shortTerm", 10, 100, 0);
    expect(store.peek("u1", "shortTerm", 10, 9_999).tokens).toBe(100);
    expect(store.peek("u1", "shortTerm", 10, 10_000).tokens).toBe(0);

    // A new add after expiry starts a fresh window anchored at that add.
    store.add("u1", "shortTerm", 10, 5, 12_000);
    expect(store.peek("u1", "shortTerm", 10, 13_000)).toMatchObject({
      tokens: 5,
      requests: 1,
      windowStartMs: 12_000,
    });
  });

  it("resets when the configured window length changes", () => {
    const store = new InMemoryWindowCounterStore();
    store.add("u1", "shortTerm", 60, 100, 1000);
    // Admin reconfigures shortTerm from 60s to 30s: old counts don't carry over.
    expect(store.peek("u1", "shortTerm", 30, 2000).tokens).toBe(0);
  });

  it("keeps windows independent per user and per window key", () => {
    const store = new InMemoryWindowCounterStore();
    store.add("u1", "shortTerm", 60, 100, 1000);
    store.add("u1", "longTerm", 3600, 100, 1000);
    store.add("u2", "shortTerm", 60, 7, 1000);

    expect(store.peek("u1", "shortTerm", 60, 2000).tokens).toBe(100);
    expect(store.peek("u1", "longTerm", 3600, 2000).tokens).toBe(100);
    expect(store.peek("u2", "shortTerm", 60, 2000).tokens).toBe(7);
  });
});
