import type { FastifyReply, FastifyRequest } from "fastify";
import type { Usage } from "../types.js";
import type { Limiter } from "../limits/limiter.js";
import type { UsageStore } from "../store/usage-store.js";
import type { ModelServer } from "./model-server.js";
import { SseUsageScanner, usageFromJson } from "./usage-extractor.js";
import { openAiError } from "../errors.js";

/**
 * Core proxy logic for OpenAI-compatible completion endpoints.
 *
 * Request lifecycle:
 *   1. authenticate (done by fastify hook; userId is on the request)
 *   2. check limits — reject with 429 before any server work
 *   3. forward to Ollama, injecting `stream_options.include_usage` for
 *      streaming requests so the terminal SSE chunk carries token counts
 *   4. pipe the response back verbatim; observe (not buffer) it to extract
 *      usage, then record usage for billing once the response completes
 *
 * The response body is never modified — clients receive exactly what Ollama
 * produced, so OpenAI SDKs work unchanged.
 */
export class ProxyHandler {
  constructor(
    private readonly modelServer: ModelServer,
    private readonly limiter: Limiter,
    private readonly usage: UsageStore,
  ) {}

  async handleCompletion(
    req: FastifyRequest,
    reply: FastifyReply,
    serverPath: string,
  ): Promise<void> {
    const userId = req.userId!;

    const decision = this.limiter.check(userId);
    if (!decision.allowed) {
      reply
        .code(429)
        .header("retry-after", String(decision.retryAfterSeconds))
        .send(openAiError(decision.reason, "rate_limit_exceeded", 429));
      return;
    }

    // Body arrives pre-parsed by fastify's JSON parser. We must parse it
    // anyway (to read `model` and inject stream_options), so re-serialize.
    const body = req.body as Record<string, unknown> | undefined;
    if (typeof body !== "object" || body === null) {
      reply.code(400).send(openAiError("Request body must be a JSON object.", "invalid_request_error", 400));
      return;
    }

    const model = typeof body.model === "string" ? body.model : "unknown";
    const isStreaming = body.stream === true;

    if (isStreaming) {
      // Guarantee the final SSE chunk includes usage, regardless of what the
      // client asked for. This is additive: OpenAI SDKs tolerate the extra
      // usage chunk even when they didn't request it.
      const existing = (body.stream_options ?? {}) as Record<string, unknown>;
      body.stream_options = { ...existing, include_usage: true };
    }

    // Abort server work if the client disconnects mid-request. The response
    // object's "close" fires when the connection drops; if the response never
    // finished, the client went away. (The request object's "close" is wrong
    // here — Node emits it as soon as the request body is fully consumed.)
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    let serverRes;
    try {
      serverRes = await this.modelServer.request({
        method: "POST",
        path: serverPath,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return; // client went away; nothing to send
      req.log.error({ err }, "server request failed");
      reply.code(502).send(openAiError("The model server is unavailable.", "server_error", 502));
      return;
    }

    if (isStreaming && serverRes.statusCode === 200) {
      await this.streamThrough(req, reply, serverRes.body, userId, model);
    } else {
      await this.bufferThrough(req, reply, serverRes.statusCode, serverRes.body, userId, model);
    }
  }

  /**
   * Streaming path: pipe SSE bytes to the client as they arrive while an
   * SseUsageScanner watches for the terminal usage chunk. Nothing is
   * buffered beyond the current partial event line.
   */
  private async streamThrough(
    req: FastifyRequest,
    reply: FastifyReply,
    serverBody: NodeJS.ReadableStream,
    userId: string,
    model: string,
  ): Promise<void> {
    const scanner = new SseUsageScanner();

    // A client vanishing mid-write emits 'error' on the raw response; without
    // a listener that would crash the process. The abort controller (wired in
    // handleCompletion) already stops the server read.
    reply.raw.on("error", () => {});

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    try {
      for await (const chunk of serverBody) {
        scanner.feed(chunk as Buffer);
        // Respect backpressure: if the client socket is full, wait for drain.
        // Also resolve on 'close' so a client that disconnects while we're
        // waiting doesn't strand this stream forever.
        if (!reply.raw.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              reply.raw.off("drain", done);
              reply.raw.off("close", done);
              resolve();
            };
            reply.raw.once("drain", done);
            reply.raw.once("close", done);
          });
          if (reply.raw.destroyed) break;
        }
      }
    } catch (err) {
      // Client disconnect or server failure mid-stream. Usage seen so far
      // (if the terminal chunk arrived) is still recorded below.
      req.log.warn({ err }, "stream interrupted");
    } finally {
      reply.raw.end();
      const usage = scanner.usage();
      if (usage) {
        this.recordUsage(userId, model, usage);
      } else {
        req.log.warn({ userId, model }, "streamed response completed without usage data");
      }
    }
  }

  /**
   * Non-streaming path: buffer the JSON response (bounded — a completion
   * body is small relative to streams), extract usage, forward verbatim.
   */
  private async bufferThrough(
    req: FastifyRequest,
    reply: FastifyReply,
    statusCode: number,
    serverBody: NodeJS.ReadableStream,
    userId: string,
    model: string,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of serverBody) chunks.push(chunk as Buffer);
    } catch (err) {
      req.log.error({ err }, "failed reading server response");
      if (!reply.sent) {
        reply.code(502).send(openAiError("The model server response was interrupted.", "server_error", 502));
      }
      return;
    }
    const raw = Buffer.concat(chunks);

    if (statusCode === 200) {
      try {
        const usage = usageFromJson(JSON.parse(raw.toString()));
        if (usage) this.recordUsage(userId, model, usage);
      } catch {
        req.log.warn({ userId, model }, "200 response was not parseable JSON; usage not recorded");
      }
    }

    reply.code(statusCode).header("content-type", "application/json").send(raw);
  }

  /** Single sink for completed-request usage: billing aggregates + rate-limit windows. */
  private recordUsage(userId: string, model: string, usage: Usage): void {
    this.usage.record(userId, model, usage);
    this.limiter.record(userId, usage);
  }

  /** Pass-through for side-effect-free endpoints like GET /v1/models. */
  async handlePassthrough(req: FastifyRequest, reply: FastifyReply, serverPath: string): Promise<void> {
    try {
      const res = await this.modelServer.request({ method: "GET", path: serverPath });
      const chunks: Buffer[] = [];
      for await (const chunk of res.body) chunks.push(chunk as Buffer);
      reply.code(res.statusCode).header("content-type", "application/json").send(Buffer.concat(chunks));
    } catch (err) {
      req.log.error({ err }, "server passthrough failed");
      reply.code(502).send(openAiError("The model server is unavailable.", "server_error", 502));
    }
  }
}
