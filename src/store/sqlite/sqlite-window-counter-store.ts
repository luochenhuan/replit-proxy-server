import type { WindowCounter, WindowCounterStore } from "../window-counter-store.js";
import type { Database } from "./database.js";

/**
 * SQLite-backed staggered fixed-window counters. Semantics match
 * InMemoryWindowCounterStore exactly:
 *   - a counter is "expired" if its configured length changed or the window
 *     elapsed (now - windowStartMs >= windowSeconds * 1000);
 *   - an expired (or missing) window reads as zero and, on the next add,
 *     starts fresh anchored at that add's timestamp.
 *
 * Durability note: persisting window counters means a restart doesn't hand a
 * user a fresh rate-limit budget. That is the correct, stricter behavior — an
 * in-memory limiter silently forgives all windowed usage on restart.
 */
export class SqliteWindowCounterStore implements WindowCounterStore {
  private readonly getStmt;
  private readonly upsert;

  constructor(db: Database) {
    this.getStmt = db.conn.prepare(
      `SELECT window_start_ms, window_seconds, tokens, requests
       FROM window_counter WHERE user_id = ? AND window_key = ?`,
    );
    // On insert, or when replacing an expired/relength'd window, this writes a
    // fresh window; otherwise it accumulates into the current one.
    this.upsert = db.conn.prepare(`
      INSERT INTO window_counter (user_id, window_key, window_start_ms, window_seconds, tokens, requests)
      VALUES (:user, :key, :start, :secs, :tokens, 1)
      ON CONFLICT(user_id, window_key) DO UPDATE SET
        window_start_ms = :start,
        window_seconds  = :secs,
        tokens          = :tokens,
        requests        = :requests
    `);
  }

  peek(userId: string, windowKey: string, windowSeconds: number, now: number = Date.now()): WindowCounter {
    const row = this.getStmt.get(userId, windowKey) as
      | { window_start_ms: number; window_seconds: number; tokens: number; requests: number }
      | undefined;
    if (!row || this.expired(row.window_start_ms, row.window_seconds, windowSeconds, now)) {
      return { windowStartMs: now, windowSeconds, tokens: 0, requests: 0 };
    }
    return {
      windowStartMs: row.window_start_ms,
      windowSeconds: row.window_seconds,
      tokens: row.tokens,
      requests: row.requests,
    };
  }

  add(
    userId: string,
    windowKey: string,
    windowSeconds: number,
    tokens: number,
    now: number = Date.now(),
  ): void {
    const row = this.getStmt.get(userId, windowKey) as
      | { window_start_ms: number; window_seconds: number; tokens: number; requests: number }
      | undefined;

    if (!row || this.expired(row.window_start_ms, row.window_seconds, windowSeconds, now)) {
      // Fresh window anchored at this add.
      this.upsert.run({
        user: userId,
        key: windowKey,
        start: now,
        secs: windowSeconds,
        tokens,
        requests: 1,
      });
      return;
    }
    // Accumulate into the active window (keep its original start).
    this.upsert.run({
      user: userId,
      key: windowKey,
      start: row.window_start_ms,
      secs: windowSeconds,
      tokens: row.tokens + tokens,
      requests: row.requests + 1,
    });
  }

  private expired(startMs: number, storedSeconds: number, windowSeconds: number, now: number): boolean {
    return storedSeconds !== windowSeconds || now - startMs >= windowSeconds * 1000;
  }
}
