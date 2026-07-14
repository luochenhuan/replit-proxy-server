import type { LimitConfig } from "../../types.js";
import type { LimitStore } from "../limit-store.js";
import type { Database } from "./database.js";

/**
 * SQLite-backed limit configs. The config document is stored as JSON in one
 * column (see the schema note) and parsed on read.
 */
export class SqliteLimitStore implements LimitStore {
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;
  private readonly allStmt;

  constructor(db: Database) {
    this.getStmt = db.conn.prepare(`SELECT config FROM user_limit WHERE user_id = ?`);
    this.setStmt = db.conn.prepare(`
      INSERT INTO user_limit (user_id, config) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET config = excluded.config
    `);
    this.delStmt = db.conn.prepare(`DELETE FROM user_limit WHERE user_id = ?`);
    this.allStmt = db.conn.prepare(`SELECT user_id, config FROM user_limit`);
  }

  get(userId: string): LimitConfig | undefined {
    const row = this.getStmt.get(userId) as { config: string } | undefined;
    return row ? (JSON.parse(row.config) as LimitConfig) : undefined;
  }

  set(userId: string, config: LimitConfig): void {
    this.setStmt.run(userId, JSON.stringify(config));
  }

  delete(userId: string): boolean {
    // node:sqlite reports affected rows via `changes`; >0 means a row existed.
    const result = this.delStmt.run(userId);
    return Number(result.changes) > 0;
  }

  entries(): Array<{ userId: string; config: LimitConfig }> {
    return (this.allStmt.all() as Array<{ user_id: string; config: string }>).map((r) => ({
      userId: r.user_id,
      config: JSON.parse(r.config) as LimitConfig,
    }));
  }
}
