/**
 * Centralized, env-driven configuration. Parsed once at startup so the rest
 * of the codebase never touches process.env directly.
 */

export interface Config {
  /** Port the proxy listens on. */
  port: number;
  host: string;
  /** Base URL of the Ollama model server (its OpenAI-compatible API root). */
  serverBaseUrl: string;
  /** Max sockets kept open to the server. */
  serverConnections: number;
  /** Milliseconds to wait for server headers before failing the request. */
  serverHeadersTimeoutMs: number;
  /** Milliseconds of body inactivity (between chunks) before aborting. */
  serverBodyTimeoutMs: number;
  /** Bearer token that grants access to the /admin API. */
  adminApiKey: string;
  /** Log level for the fastify logger. */
  logLevel: string;
  /** Storage backend: "memory" (ephemeral) or "sqlite" (durable, file-backed). */
  storage: "memory" | "sqlite";
  /** SQLite file path when storage is "sqlite". */
  dbPath: string;
}

function storageEnv(env: NodeJS.ProcessEnv): "memory" | "sqlite" {
  const raw = (env.STORAGE ?? "sqlite").toLowerCase();
  if (raw !== "memory" && raw !== "sqlite") {
    throw new Error(`Invalid value for STORAGE: ${raw} (expected "memory" or "sqlite")`);
  }
  return raw;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intEnv("PORT", 8000),
    host: env.HOST ?? "0.0.0.0",
    serverBaseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    serverConnections: intEnv("SERVER_CONNECTIONS", 128),
    serverHeadersTimeoutMs: intEnv("SERVER_HEADERS_TIMEOUT_MS", 120_000),
    serverBodyTimeoutMs: intEnv("SERVER_BODY_TIMEOUT_MS", 300_000),
    adminApiKey: env.ADMIN_API_KEY ?? "admin-secret",
    logLevel: env.LOG_LEVEL ?? "info",
    storage: storageEnv(env),
    dbPath: env.DB_PATH ?? "data/meter.db",
  };
}
