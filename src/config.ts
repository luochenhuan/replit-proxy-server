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
  /** Optional bearer token used to authenticate with a remote Ollama server. */
  serverApiKey?: string;
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

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: ${raw}`);
  }
  return parsed;
}

function modelServerEnv(env: NodeJS.ProcessEnv): Pick<Config, "serverBaseUrl" | "serverApiKey"> {
  const rawBaseUrl = env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const serverApiKey = env.OLLAMA_API_KEY?.trim() || undefined;

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid value for OLLAMA_BASE_URL: ${rawBaseUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid protocol for OLLAMA_BASE_URL: ${url.protocol} (expected "http:" or "https:")`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OLLAMA_BASE_URL must be an HTTP(S) origin without credentials, a path, a query, or a fragment");
  }
  if (serverApiKey && url.protocol !== "https:") {
    throw new Error("OLLAMA_BASE_URL must use HTTPS when OLLAMA_API_KEY is set");
  }
  if (url.hostname === "ollama.com" && !serverApiKey) {
    throw new Error("OLLAMA_API_KEY is required when OLLAMA_BASE_URL points to ollama.com");
  }

  return { serverBaseUrl: url.origin, serverApiKey };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modelServer = modelServerEnv(env);
  return {
    port: intEnv(env, "PORT", 8000),
    host: env.HOST ?? "0.0.0.0",
    ...modelServer,
    serverConnections: intEnv(env, "SERVER_CONNECTIONS", 128),
    serverHeadersTimeoutMs: intEnv(env, "SERVER_HEADERS_TIMEOUT_MS", 120_000),
    serverBodyTimeoutMs: intEnv(env, "SERVER_BODY_TIMEOUT_MS", 300_000),
    adminApiKey: env.ADMIN_API_KEY ?? "admin-secret",
    logLevel: env.LOG_LEVEL ?? "info",
    storage: storageEnv(env),
    dbPath: env.DB_PATH ?? "data/meter.db",
  };
}
