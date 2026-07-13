import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { ModelServer, ModelServerResponse } from "../src/proxy/model-server.js";

/**
 * Fake server so the full HTTP surface (auth, limits, usage accounting,
 * response passthrough) is exercised without a live Ollama.
 */
class FakeModelServer {
  lastBody: Record<string, unknown> | undefined;
  respondWith: () => ModelServerResponse = () => jsonResponse(completionBody(10, 20));

  async request(opts: { body?: string | Buffer }): Promise<ModelServerResponse> {
    if (opts.body) this.lastBody = JSON.parse(opts.body.toString());
    return this.respondWith();
  }

  async close(): Promise<void> {}
}

function completionBody(prompt: number, completion: number) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "llama3.2:1b",
    choices: [{ index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

function jsonResponse(body: unknown, statusCode = 200): ModelServerResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  };
}

function sseResponse(events: string[]): ModelServerResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "text/event-stream" },
    body: Readable.from(events.map((e) => Buffer.from(e))),
  };
}

const ADMIN = { authorization: "Bearer test-admin-key" };
const USER = { authorization: "Bearer user-token-1", "content-type": "application/json" };

describe("proxy app", () => {
  let app: FastifyInstance;
  let server: FakeModelServer;

  beforeEach(() => {
    server = new FakeModelServer();
    const config = loadConfig({ ADMIN_API_KEY: "test-admin-key", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    app = buildApp(config, { modelServer: server as unknown as ModelServer });
  });

  afterEach(async () => {
    await app.close();
  });

  const chatPayload = JSON.stringify({
    model: "llama3.2:1b",
    messages: [{ role: "user", content: "What is 2+2?" }],
  });

  it("rejects requests without an API key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: chatPayload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("missing_api_key");
  });

  it("proxies completions and records usage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: USER,
      payload: chatPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("4");

    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: USER });
    const body = usage.json();
    expect(body.totals.total_tokens).toBe(30);
    expect(body.models["llama3.2:1b"].requests).toBe(1);
  });

  it("serves both /chat/completions and /v1/chat/completions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat/completions",
      headers: USER,
      payload: chatPayload,
    });
    expect(res.statusCode).toBe(200);
  });

  it("injects include_usage into streaming requests and records streamed usage", async () => {
    server.respondWith = () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"4"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
        "data: [DONE]\n\n",
      ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: USER,
      payload: JSON.stringify({ model: "llama3.2:1b", messages: [], stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("[DONE]");
    expect(server.lastBody?.stream_options).toEqual({ include_usage: true });

    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: USER });
    expect(usage.json().totals.total_tokens).toBe(10);
  });

  it("keeps per-user usage isolated", async () => {
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
    const other = await app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: "Bearer another-user" },
    });
    expect(other.json().totals.total_tokens).toBe(0);
  });

  it("passes server errors through without recording usage", async () => {
    server.respondWith = () => jsonResponse({ error: { message: "model not found" } }, 404);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: USER,
      payload: chatPayload,
    });
    expect(res.statusCode).toBe(404);

    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: USER });
    expect(usage.json().totals.total_tokens).toBe(0);
  });

  describe("admin API", () => {
    it("requires the admin key", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/limits", headers: USER });
      expect(res.statusCode).toBe(403);
    });

    it("validates limit configs", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/limits/user_x",
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({ shortTerm: { windowSeconds: 60 } }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("sets, lists, reads, and deletes limits", async () => {
      const put = await app.inject({
        method: "PUT",
        url: "/admin/limits/user_x",
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({ total: { maxTokens: 1000 } }),
      });
      expect(put.statusCode).toBe(200);

      const list = await app.inject({ method: "GET", url: "/admin/limits", headers: ADMIN });
      expect(list.json().limits).toHaveLength(1);

      const get = await app.inject({ method: "GET", url: "/admin/limits/user_x", headers: ADMIN });
      expect(get.json().total.maxTokens).toBe(1000);

      const del = await app.inject({ method: "DELETE", url: "/admin/limits/user_x", headers: ADMIN });
      expect(del.statusCode).toBe(204);

      const gone = await app.inject({ method: "GET", url: "/admin/limits/user_x", headers: ADMIN });
      expect(gone.statusCode).toBe(404);
    });
  });

  describe("limit enforcement end-to-end", () => {
    async function userIdOf(headers: Record<string, string>): Promise<string> {
      const res = await app.inject({ method: "GET", url: "/v1/usage", headers });
      return res.json().user_id;
    }

    it("returns 429 with an OpenAI-shaped error once a total limit is hit", async () => {
      const userId = await userIdOf(USER);
      await app.inject({
        method: "PUT",
        url: `/admin/limits/${userId}`,
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({ total: { maxTokens: 30 } }),
      });

      // First request consumes 30 tokens — allowed (limit checked before).
      const first = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      expect(first.statusCode).toBe(200);

      // Now at the cap: rejected before reaching server.
      const second = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      expect(second.statusCode).toBe(429);
      expect(second.json().error.type).toBe("rate_limit_error");
      expect(second.headers["retry-after"]).toBeDefined();
    });

    it("enforces short-term request limits", async () => {
      const userId = await userIdOf(USER);
      await app.inject({
        method: "PUT",
        url: `/admin/limits/${userId}`,
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({ shortTerm: { windowSeconds: 60, maxRequests: 2 } }),
      });

      for (let i = 0; i < 2; i++) {
        const ok = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
        expect(ok.statusCode).toBe(200);
      }
      const blocked = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      expect(blocked.statusCode).toBe(429);
    });
  });

  it("exposes admin usage across users", async () => {
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
    const res = await app.inject({ method: "GET", url: "/admin/usage", headers: ADMIN });
    const users = res.json().users;
    expect(users).toHaveLength(1);
    expect(users[0].total_tokens).toBe(30);
  });

  it("responds to health checks without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
