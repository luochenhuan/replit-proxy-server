import { DatabaseSync } from "node:sqlite";

/**
 * Thin wrapper around a single synchronous SQLite connection.
 *
 * Why SQLite + node:sqlite:
 *   - The proxy is single-node; SQLite gives durable, file-backed storage with
 *     no server to run and no async in the hot path — a match for the existing
 *     synchronous store interfaces (record/check happen inline per request).
 *   - node:sqlite is built into Node (v22.5+), so this adds zero dependencies
 *     and no native build step. better-sqlite3 is the drop-in fallback if an
 *     older runtime is required.
 *
 * Pragmas:
 *   - WAL: readers don't block the writer, so dashboard reads never stall the
 *     request-path writes. Also faster for our write-heavy usage recording.
 *   - synchronous=NORMAL: durable across app crashes (only a power loss can
 *     lose the last transaction under WAL), at a large speed win over FULL.
 *   - foreign_keys/busy_timeout: correctness and resilience under contention.
 *
 * The schema is applied idempotently at construction; there is one table per
 * store, so each store owns its own rows and nothing cross-references.
 */
export class Database {
  readonly conn: DatabaseSync;

  constructor(path: string) {
    this.conn = new DatabaseSync(path);
    this.conn.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  private migrate(): void {
    this.conn.exec(`
      -- Lifetime usage aggregates, one row per (user, model). The billing
      -- source of truth; monotonically accumulated.
      CREATE TABLE IF NOT EXISTS usage_aggregate (
        user_id           TEXT NOT NULL,
        model             TEXT NOT NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        requests          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, model)
      );

      -- Admin-configured limits, one row per user. The config is stored as JSON
      -- because it is a small, read-as-a-unit document with optional sub-parts;
      -- normalizing it into columns would buy nothing here.
      CREATE TABLE IF NOT EXISTS user_limit (
        user_id  TEXT PRIMARY KEY,
        config   TEXT NOT NULL
      );

      -- Staggered fixed-window rate-limit counters, one row per (user, window).
      CREATE TABLE IF NOT EXISTS window_counter (
        user_id          TEXT NOT NULL,
        window_key       TEXT NOT NULL,
        window_start_ms  INTEGER NOT NULL,
        window_seconds   INTEGER NOT NULL,
        tokens           INTEGER NOT NULL,
        requests         INTEGER NOT NULL,
        PRIMARY KEY (user_id, window_key)
      );

      -- Per-call history. Bounded per user by deleting oldest rows on insert.
      CREATE TABLE IF NOT EXISTS call_history (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        TEXT NOT NULL,
        at             INTEGER NOT NULL,
        model          TEXT NOT NULL,
        streaming      INTEGER NOT NULL,
        input_tokens   INTEGER NOT NULL,
        output_tokens  INTEGER NOT NULL,
        total_tokens   INTEGER NOT NULL,
        cost_usd       REAL NOT NULL,
        outcome        TEXT NOT NULL,
        status_code    INTEGER NOT NULL
      );
      -- Serves per-user pruning (by id) and the newest-first-by-timestamp read.
      CREATE INDEX IF NOT EXISTS idx_call_history_user_id_id
        ON call_history (user_id, id);
      CREATE INDEX IF NOT EXISTS idx_call_history_user_id_at
        ON call_history (user_id, at DESC);
    `);
  }

  close(): void {
    // Idempotent: shutdown hooks (and tests) may call this more than once.
    if (this.conn.isOpen) this.conn.close();
  }
}
