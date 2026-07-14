import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/store/sqlite/database.js";
import { SqliteUsageStore } from "../src/store/sqlite/sqlite-usage-store.js";
import { SqliteLimitStore } from "../src/store/sqlite/sqlite-limit-store.js";
import { SqliteWindowCounterStore } from "../src/store/sqlite/sqlite-window-counter-store.js";
import { SqliteCallHistoryStore } from "../src/store/sqlite/sqlite-call-history-store.js";
import type { CallRecord } from "../src/store/call-history-store.js";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meter-sqlite-"));
  dbPath = join(dir, "test.db");
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function usage(input: number, output: number) {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

describe("SqliteUsageStore", () => {
  it("accumulates lifetime usage per model across records", () => {
    const store = new SqliteUsageStore(db);
    store.record("u1", "llama3.2:1b", usage(50, 50));
    store.record("u1", "llama3.2:1b", usage(25, 25));
    store.record("u1", "moondream", usage(10, 20));

    expect(store.totalsByModel("u1").get("llama3.2:1b")).toEqual({
      inputTokens: 75,
      outputTokens: 75,
      totalTokens: 150,
      requests: 2,
    });
    expect(store.totalsByModel("u1").get("moondream")).toMatchObject({ totalTokens: 30, requests: 1 });
    expect(store.userIds()).toEqual(["u1"]);
  });

  it("isolates users", () => {
    const store = new SqliteUsageStore(db);
    store.record("u1", "m", usage(50, 50));
    expect(store.totalsByModel("u2").size).toBe(0);
  });
});

describe("SqliteLimitStore", () => {
  it("stores, reads, lists, and deletes limit configs", () => {
    const store = new SqliteLimitStore(db);
    expect(store.get("u1")).toBeUndefined();

    store.set("u1", { longTerm: { windowSeconds: 3600, maxTokens: 1000 }, shortTerm: { windowSeconds: 60, maxRequests: 5 } });
    expect(store.get("u1")).toEqual({
      longTerm: { windowSeconds: 3600, maxTokens: 1000 },
      shortTerm: { windowSeconds: 60, maxRequests: 5 },
    });

    store.set("u1", { shortTerm: { windowSeconds: 60, maxRequests: 9 } }); // replace
    expect(store.get("u1")).toEqual({ shortTerm: { windowSeconds: 60, maxRequests: 9 } });

    expect(store.entries()).toHaveLength(1);
    expect(store.delete("u1")).toBe(true);
    expect(store.delete("u1")).toBe(false); // already gone
    expect(store.get("u1")).toBeUndefined();
  });
});

describe("SqliteWindowCounterStore", () => {
  it("accumulates within an active window and staggers the start", () => {
    const store = new SqliteWindowCounterStore(db);
    store.add("u1", "shortTerm", 60, 100, 45_500);
    store.add("u1", "shortTerm", 60, 50, 50_000);
    expect(store.peek("u1", "shortTerm", 60, 59_000)).toMatchObject({
      tokens: 150,
      requests: 2,
      windowStartMs: 45_500,
    });
    expect(store.peek("u1", "shortTerm", 60, 105_500).requests).toBe(0); // expired at start+60s
  });

  it("resets after expiry and when the window length changes", () => {
    const store = new SqliteWindowCounterStore(db);
    store.add("u1", "shortTerm", 10, 100, 0);
    expect(store.peek("u1", "shortTerm", 10, 9_999).tokens).toBe(100);
    expect(store.peek("u1", "shortTerm", 10, 10_000).tokens).toBe(0); // expired

    store.add("u1", "shortTerm", 10, 5, 12_000);
    expect(store.peek("u1", "shortTerm", 10, 13_000)).toMatchObject({ tokens: 5, windowStartMs: 12_000 });

    // Length change is treated as a reset.
    expect(store.peek("u1", "shortTerm", 30, 13_000).tokens).toBe(0);
  });
});

describe("SqliteCallHistoryStore", () => {
  function call(at: number, o: Partial<CallRecord> = {}): CallRecord {
    return {
      at, model: "m", streaming: false,
      inputTokens: 10, outputTokens: 20, totalTokens: 30,
      costUsd: 0.001, outcome: "ok", statusCode: 200, ...o,
    };
  }

  it("returns calls newest-first and preserves all fields", () => {
    const store = new SqliteCallHistoryStore(db);
    store.record("u1", call(1000, { streaming: true }));
    store.record("u1", call(2000, { outcome: "rejected", statusCode: 429, costUsd: 0 }));

    const recent = store.recent("u1", 10);
    expect(recent.map((c) => c.at)).toEqual([2000, 1000]);
    expect(recent[0]).toMatchObject({ outcome: "rejected", statusCode: 429, costUsd: 0 });
    expect(recent[1]).toMatchObject({ streaming: true, inputTokens: 10, outputTokens: 20 });
  });

  it("sorts by timestamp descending even when recorded out of order", () => {
    const store = new SqliteCallHistoryStore(db);
    store.record("u1", call(2000));
    store.record("u1", call(1000));
    store.record("u1", call(3000));
    expect(store.recent("u1", 10).map((c) => c.at)).toEqual([3000, 2000, 1000]);
  });

  it("evicts oldest beyond capacity (ring buffer)", () => {
    const store = new SqliteCallHistoryStore(db, 3);
    for (let i = 0; i < 5; i++) store.record("u1", call(i));
    expect(store.count("u1")).toBe(3);
    expect(store.recent("u1", 10).map((c) => c.at)).toEqual([4, 3, 2]);
  });

  it("isolates users", () => {
    const store = new SqliteCallHistoryStore(db);
    store.record("u1", call(1000));
    expect(store.recent("u2", 10)).toEqual([]);
    expect(store.count("u2")).toBe(0);
  });
});

describe("persistence across a reopen (simulated restart)", () => {
  it("retains usage, limits, windows, and history after closing and reopening the file", () => {
    // Write with one connection.
    const u1 = new SqliteUsageStore(db);
    const l1 = new SqliteLimitStore(db);
    const w1 = new SqliteWindowCounterStore(db);
    const h1 = new SqliteCallHistoryStore(db);
    u1.record("alice", "llama3.2:1b", usage(100, 40));
    l1.set("alice", { shortTerm: { windowSeconds: 60, maxRequests: 5 } });
    w1.add("alice", "shortTerm", 60, 140, 1000);
    h1.record("alice", {
      at: 1000, model: "llama3.2:1b", streaming: false,
      inputTokens: 100, outputTokens: 40, totalTokens: 140,
      costUsd: 0.0001, outcome: "ok", statusCode: 200,
    });
    db.close();

    // Reopen the same file with a fresh connection - the "restart".
    const db2 = new Database(dbPath);
    try {
      expect(new SqliteUsageStore(db2).totalsByModel("alice").get("llama3.2:1b")?.totalTokens).toBe(140);
      expect(new SqliteLimitStore(db2).get("alice")).toEqual({ shortTerm: { windowSeconds: 60, maxRequests: 5 } });
      expect(new SqliteWindowCounterStore(db2).peek("alice", "shortTerm", 60, 2000).tokens).toBe(140);
      expect(new SqliteCallHistoryStore(db2).recent("alice", 10)).toHaveLength(1);
    } finally {
      db2.close();
    }
  });
});
