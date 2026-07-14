import type { UsageAggregate, Usage } from "../../types.js";
import type { UsageStore } from "../usage-store.js";
import type { Database } from "./database.js";

/**
 * SQLite-backed usage aggregates. Same contract as InMemoryUsageStore, but
 * durable across restarts. Each record is a single UPSERT that accumulates the
 * running totals, so there is no read-modify-write race even under concurrency.
 */
export class SqliteUsageStore implements UsageStore {
  private readonly upsert;
  private readonly byModel;
  private readonly users;

  constructor(db: Database) {
    this.upsert = db.conn.prepare(`
      INSERT INTO usage_aggregate (user_id, model, input_tokens, output_tokens, total_tokens, requests)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(user_id, model) DO UPDATE SET
        input_tokens  = input_tokens  + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens  = total_tokens  + excluded.total_tokens,
        requests      = requests      + 1
    `);
    this.byModel = db.conn.prepare(
      `SELECT model, input_tokens, output_tokens, total_tokens, requests
       FROM usage_aggregate WHERE user_id = ?`,
    );
    this.users = db.conn.prepare(`SELECT DISTINCT user_id FROM usage_aggregate`);
  }

  record(userId: string, model: string, usage: Usage): void {
    this.upsert.run(userId, model, usage.inputTokens, usage.outputTokens, usage.totalTokens);
  }

  totalsByModel(userId: string): Map<string, UsageAggregate> {
    const out = new Map<string, UsageAggregate>();
    for (const row of this.byModel.all(userId) as Array<Record<string, number | string>>) {
      out.set(row.model as string, {
        inputTokens: row.input_tokens as number,
        outputTokens: row.output_tokens as number,
        totalTokens: row.total_tokens as number,
        requests: row.requests as number,
      });
    }
    return out;
  }

  userIds(): string[] {
    return (this.users.all() as Array<{ user_id: string }>).map((r) => r.user_id);
  }
}
