import { Pool } from "undici";
import type { Config } from "../config.js";

/**
 * Thin wrapper around a undici connection pool to the Ollama server.
 *
 * undici.Pool multiplexes requests over a bounded set of keep-alive sockets,
 * which is what lets a single proxy process sustain hundreds of concurrent
 * server requests without per-request TCP/TLS setup cost.
 */
export interface ModelServerResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
}

export class ModelServer {
  private readonly pool: Pool;
  private readonly authHeaders: Record<string, string>;

  constructor(private readonly config: Config) {
    this.authHeaders = config.serverApiKey
      ? { authorization: `Bearer ${config.serverApiKey}` }
      : {};
    this.pool = new Pool(config.serverBaseUrl, {
      connections: config.serverConnections,
      pipelining: 1,
      keepAliveTimeout: 60_000,
      headersTimeout: config.serverHeadersTimeoutMs,
      bodyTimeout: config.serverBodyTimeoutMs,
    });
  }

  async request(opts: {
    method: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal?: AbortSignal;
  }): Promise<ModelServerResponse> {
    const res = await this.pool.request({
      method: opts.method,
      path: opts.path,
      // The upstream credential is independent of the client credential used
      // to authenticate with this proxy. Keep it last so callers cannot
      // replace the configured model-server authorization header.
      headers: { ...opts.headers, ...this.authHeaders },
      body: opts.body,
      signal: opts.signal,
    });
    return { statusCode: res.statusCode, headers: res.headers as ModelServerResponse["headers"], body: res.body };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
