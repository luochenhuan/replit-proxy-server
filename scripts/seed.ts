/**
 * Seed the database with demo data so both dashboards have something to show.
 *
 * Run once:   npm run seed
 * Then start: npm start   (and open http://localhost:8000)
 *
 * It writes through the same SQLite stores the server uses (honoring DB_PATH),
 * so the running server serves this data directly. Users are seeded under real
 * API tokens; the exact tokens to type into the developer dashboard, and the
 * admin key, are printed at the end.
 *
 * Idempotent: re-running clears the demo users' rows first (reset()), so usage
 * and window counters never double-count. Any non-demo users are left intact.
 *
 * Requires STORAGE=sqlite (the default). Seeding the in-memory backend would be
 * useless: that data lives only in this short-lived process and the server -
 * a separate process - would never see it. The script refuses memory mode.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/store/sqlite/database.js";
import { SqliteUsageStore } from "../src/store/sqlite/sqlite-usage-store.js";
import { SqliteLimitStore } from "../src/store/sqlite/sqlite-limit-store.js";
import { SqliteWindowCounterStore } from "../src/store/sqlite/sqlite-window-counter-store.js";
import { SqliteCallHistoryStore } from "../src/store/sqlite/sqlite-call-history-store.js";
import { Pricing } from "../src/billing/pricing.js";
import { identify } from "../src/auth.js";
import type { Usage, LimitConfig } from "../src/types.js";
import type { CallOutcome } from "../src/store/call-history-store.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A demo user: the token a developer would type, and how much traffic to fabricate. */
interface DemoUser {
  token: string;
  label: string;
  models: string[];
  calls: number;
  /** Fractions of calls that were rejected (429) / errored (502), for realistic history. */
  rejectRate: number;
  errorRate: number;
  limits?: LimitConfig;
}

const USERS: DemoUser[] = [
  {
    token: "demo-alice",
    label: "heavy user, tight rate limits",
    models: ["llama3.2:1b", "moondream"],
    calls: 40,
    rejectRate: 0.1,
    errorRate: 0.03,
    // Burst + daily windowed limits — makes the gauges meaningful.
    limits: {
      shortTerm: { windowSeconds: 60, maxRequests: 30 },
      longTerm: { windowSeconds: DAY / 1000, maxTokens: 500_000 },
    },
  },
  {
    token: "demo-bob",
    label: "moderate user, no limits",
    models: ["llama3.2:1b"],
    calls: 18,
    rejectRate: 0,
    errorRate: 0.05,
  },
  {
    token: "demo-carol",
    label: "light user, vision only",
    models: ["moondream"],
    calls: 6,
    rejectRate: 0,
    errorRate: 0,
    limits: { longTerm: { windowSeconds: DAY / 1000, maxRequests: 1000 } },
  },
];

/**
 * Deterministic pseudo-random in [0,1) from an integer seed, so re-running the
 * script reproduces the same demo data (Date.now aside, which shifts the ages).
 */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function fabricateUsage(model: string, seed: number): Usage {
  const vision = model === "moondream";
  const input = Math.floor((vision ? 300 : 20) + rand(seed) * (vision ? 500 : 120));
  const output = Math.floor(10 + rand(seed + 1) * (vision ? 120 : 200));
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

function pickOutcome(u: DemoUser, seed: number): CallOutcome {
  const r = rand(seed + 7);
  if (r < u.rejectRate) return "rejected";
  if (r < u.rejectRate + u.errorRate) return "error";
  return "ok";
}

function statusFor(outcome: CallOutcome): number {
  return outcome === "ok" ? 200 : outcome === "rejected" ? 429 : 502;
}

/** Remove all rows for the given user ids across every table (idempotent re-seed). */
function reset(db: Database, userIds: string[]): void {
  const tables = ["usage_aggregate", "user_limit", "window_counter", "call_history"];
  for (const table of tables) {
    const stmt = db.conn.prepare(`DELETE FROM ${table} WHERE user_id = ?`);
    for (const id of userIds) stmt.run(id);
  }
}

function main(): void {
  const config = loadConfig();
  if (config.storage !== "sqlite") {
    console.error(
      `Seeding requires STORAGE=sqlite (got "${config.storage}").\n` +
        `In-memory data would not be shared with the server process. ` +
        `Re-run as:  STORAGE=sqlite npm run seed`,
    );
    process.exit(1);
  }

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  const usage = new SqliteUsageStore(db);
  const limits = new SqliteLimitStore(db);
  const windows = new SqliteWindowCounterStore(db);
  const history = new SqliteCallHistoryStore(db);
  const pricing = new Pricing();

  const now = Date.now();
  const userIds = USERS.map((u) => identify(u.token).userId);
  reset(db, userIds);

  const printable: Array<{ token: string; userId: string; label: string }> = [];

  for (const [i, user] of USERS.entries()) {
    const userId = userIds[i]!;
    printable.push({ token: user.token, userId, label: user.label });

    if (user.limits) limits.set(userId, user.limits);

    for (let c = 0; c < user.calls; c++) {
      const seed = i * 1000 + c;
      const model = user.models[c % user.models.length]!;
      const outcome = pickOutcome(user, seed);
      // Spread calls across roughly the last 3 days.
      const at = now - Math.floor(rand(seed + 3) * 3 * DAY);

      const usageVal =
        outcome === "ok"
          ? fabricateUsage(model, seed)
          : { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const costUsd = outcome === "ok" ? pricing.cost(model, usageVal) : 0;

      if (outcome === "ok") {
        usage.record(userId, model, usageVal);
        // Advance rate-limit windows as a real request would (only for windows
        // the user actually has configured).
        if (user.limits?.shortTerm) {
          windows.add(userId, "shortTerm", user.limits.shortTerm.windowSeconds, usageVal.totalTokens, at);
        }
        if (user.limits?.longTerm) {
          windows.add(userId, "longTerm", user.limits.longTerm.windowSeconds, usageVal.totalTokens, at);
        }
      }

      history.record(userId, {
        at,
        model,
        streaming: rand(seed + 5) < 0.4,
        inputTokens: usageVal.inputTokens,
        outputTokens: usageVal.outputTokens,
        totalTokens: usageVal.totalTokens,
        costUsd,
        outcome,
        statusCode: statusFor(outcome),
      });
    }
  }

  db.close();

  console.log(`\nSeeded ${USERS.length} users into ${config.dbPath}.`);
  console.log("\nDeveloper dashboard  ->  http://localhost:8000/dashboard");
  console.log("Sign in with any of these API tokens:");
  for (const p of printable) console.log(`   ${p.token.padEnd(12)}  ${p.label}`);
  console.log("\nAdmin dashboard      ->  http://localhost:8000/admin/dashboard");
  console.log(`Sign in with the admin key:  ${config.adminApiKey}`);
  console.log("\nStart the server if it isn't running:  npm start\n");
}

main();
