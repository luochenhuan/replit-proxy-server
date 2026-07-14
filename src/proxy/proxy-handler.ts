import type { FastifyReply, FastifyRequest } from "fastify";
import type { Usage } from "../types.js";
import type { Limiter } from "../limits/limiter.js";
import type { UsageStore } from "../store/usage-store.js";
import type { CallHistoryStore, CallOutcome } from "../store/call-history-store.js";
import type { Pricing } from "../billing/pricing.js";
import type { ModelServer } from "./model-server.js";
import { SseUsageScanner, usageFromJson } from "./usage-extractor.js";
import { openAiError } from "../errors.js";

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

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
    private readonly history: CallHistoryStore,
    private readonly pricing: Pricing,
  ) {}

  async handleCompletion(
    req: FastifyRequest,
    reply: FastifyReply,
    serverPath: string,
  ): Promise<void> {
    const userId = req.userId!;

    // Parse the body first so a rejected call can still be attributed to its
    // model in the history view.
    const body = req.body as Record<string, unknown> | undefined;
    if (typeof body !== "object" || body === null) {
      reply.code(400).send(openAiError("Request body must be a JSON object.", "invalid_request_error", 400));
      return;
    }

    const model = typeof body.model === "string" ? body.model : "unknown";
    const isStreaming = body.stream === true;

    const decision = this.limiter.check(userId);
    if (!decision.allowed) {
      this.recordCall(userId, model, isStreaming, NO_USAGE, "rejected", 429);
      reply
        .code(429)
        .header("retry-after", String(decision.retryAfterSeconds))
        .send(openAiError(decision.reason, "rate_limit_exceeded", 429));
      return;
    }

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
      this.recordCall(userId, model, isStreaming, NO_USAGE, "error", 502);
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
        this.recordCall(userId, model, true, usage, "ok", 200);
      } else {
        req.log.warn({ userId, model }, "streamed response completed without usage data");
        this.recordCall(userId, model, true, NO_USAGE, "ok", 200);
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
      let usage: Usage | undefined;
      try {
        usage = usageFromJson(JSON.parse(raw.toString()));
      } catch {
        req.log.warn({ userId, model }, "200 response was not parseable JSON; usage not recorded");
      }
      if (usage) this.recordUsage(userId, model, usage);
      this.recordCall(userId, model, false, usage ?? NO_USAGE, "ok", 200);
    } else {
      // Upstream returned an error (e.g. unknown model). Nothing was generated,
      // so nothing is billed, but the attempt is visible in history.
      this.recordCall(userId, model, false, NO_USAGE, "error", statusCode);
    }

    reply.code(statusCode).header("content-type", "application/json").send(raw);
  }

  /** Single sink for completed-request usage: billing aggregates + rate-limit windows. */
  private recordUsage(userId: string, model: string, usage: Usage): void {
    this.usage.record(userId, model, usage);
    this.limiter.record(userId, usage);
  }

  /** Append one call to the user's history, with cost computed from the price sheet. */
  private recordCall(
    userId: string,
    model: string,
    streaming: boolean,
    usage: Usage,
    outcome: CallOutcome,
    statusCode: number,
  ): void {
    const costUsd = outcome === "ok" ? this.pricing.cost(model, usage) : 0;
    this.history.record(userId, {
      at: Date.now(),
      model,
      streaming,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUsd,
      outcome,
      statusCode,
    });
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
