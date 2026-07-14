import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import type { UsageStore } from "./usage-store.js";
import type { LimitStore } from "./limit-store.js";
import type { WindowCounterStore } from "./window-counter-store.js";
import type { CallHistoryStore } from "./call-history-store.js";
import { InMemoryUsageStore } from "./usage-store.js";
import { InMemoryLimitStore } from "./limit-store.js";
import { InMemoryWindowCounterStore } from "./window-counter-store.js";
import { InMemoryCallHistoryStore } from "./call-history-store.js";
import { Database } from "./sqlite/database.js";
import { SqliteUsageStore } from "./sqlite/sqlite-usage-store.js";
import { SqliteLimitStore } from "./sqlite/sqlite-limit-store.js";
import { SqliteWindowCounterStore } from "./sqlite/sqlite-window-counter-store.js";
import { SqliteCallHistoryStore } from "./sqlite/sqlite-call-history-store.js";

/**
 * The full set of stores the app needs, plus an optional close() for backends
 * (SQLite) that hold a resource. The app depends only on the interfaces, so it
 * neither knows nor cares which backend it got.
 */
export interface Storage {
  usage: UsageStore;
  limits: LimitStore;
  windows: WindowCounterStore;
  history: CallHistoryStore;
  close(): void;
}

/** Build the store set selected by config.storage. */
export function createStorage(config: Config): Storage {
  if (config.storage === "memory") {
    return {
      usage: new InMemoryUsageStore(),
      limits: new InMemoryLimitStore(),
      windows: new InMemoryWindowCounterStore(),
      history: new InMemoryCallHistoryStore(),
      close: () => {},
    };
  }

  // sqlite: ensure the parent directory exists, then open one shared connection.
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  return {
    usage: new SqliteUsageStore(db),
    limits: new SqliteLimitStore(db),
    windows: new SqliteWindowCounterStore(db),
    history: new SqliteCallHistoryStore(db),
    close: () => db.close(),
  };
}
