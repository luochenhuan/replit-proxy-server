import type { CallHistoryStore, CallRecord } from "../call-history-store.js";
import type { Database } from "./database.js";

/**
 * SQLite-backed call history. Matches InMemoryCallHistoryStore: newest-first
 * reads and a bounded per-user retention (oldest rows pruned on insert), so
 * table size stays O(users x capacity) rather than growing with all traffic.
 *
 * Insert + prune run in a transaction so a reader never sees a user briefly
 * over capacity.
 */
export class SqliteCallHistoryStore implements CallHistoryStore {
  private readonly insertStmt;
  private readonly pruneStmt;
  private readonly recentStmt;
  private readonly countStmt;
  private readonly tx;

  constructor(
    db: Database,
    private readonly capacityPerUser: number = 500,
  ) {
    this.insertStmt = db.conn.prepare(`
      INSERT INTO call_history
        (user_id, at, model, streaming, input_tokens, output_tokens, total_tokens, cost_usd, outcome, status_code)
      VALUES (:user, :at, :model, :streaming, :input, :output, :total, :cost, :outcome, :status)
    `);
    // Delete everything but the newest `capacity` rows for this user (highest
    // ids are newest, since id is a monotonic AUTOINCREMENT).
    this.pruneStmt = db.conn.prepare(`
      DELETE FROM call_history
      WHERE user_id = :user AND id NOT IN (
        SELECT id FROM call_history WHERE user_id = :user ORDER BY id DESC LIMIT :cap
      )
    `);
    this.recentStmt = db.conn.prepare(`
      SELECT at, model, streaming, input_tokens, output_tokens, total_tokens, cost_usd, outcome, status_code
      FROM call_history WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?
    `);
    this.countStmt = db.conn.prepare(`SELECT COUNT(*) AS n FROM call_history WHERE user_id = ?`);

    // node:sqlite has no .transaction() helper; wrap the two statements by hand.
    this.tx = (record: CallRecord, userId: string) => {
      db.conn.exec("BEGIN");
      try {
        this.insertStmt.run({
          user: userId,
          at: record.at,
          model: record.model,
          streaming: record.streaming ? 1 : 0,
          input: record.inputTokens,
          output: record.outputTokens,
          total: record.totalTokens,
          cost: record.costUsd,
          outcome: record.outcome,
          status: record.statusCode,
        });
        this.pruneStmt.run({ user: userId, cap: this.capacityPerUser });
        db.conn.exec("COMMIT");
      } catch (err) {
        db.conn.exec("ROLLBACK");
        throw err;
      }
    };
  }

  record(userId: string, call: CallRecord): void {
    this.tx(call, userId);
  }

  recent(userId: string, limit: number): CallRecord[] {
    const rows = this.recentStmt.all(userId, limit) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      at: r.at as number,
      model: r.model as string,
      streaming: r.streaming === 1,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      totalTokens: r.total_tokens as number,
      costUsd: r.cost_usd as number,
      outcome: r.outcome as CallRecord["outcome"],
      statusCode: r.status_code as number,
    }));
  }

  count(userId: string): number {
    return (this.countStmt.get(userId) as { n: number }).n;
  }
}
