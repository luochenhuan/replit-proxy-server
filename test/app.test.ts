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
    const config = loadConfig({ ADMIN_API_KEY: "test-admin-key", LOG_LEVEL: "silent", STORAGE: "memory" } as NodeJS.ProcessEnv);
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
        payload: JSON.stringify({ longTerm: { windowSeconds: 3600, maxTokens: 1000 } }),
      });
      expect(put.statusCode).toBe(200);

      const list = await app.inject({ method: "GET", url: "/admin/limits", headers: ADMIN });
      expect(list.json().limits).toHaveLength(1);

      const get = await app.inject({ method: "GET", url: "/admin/limits/user_x", headers: ADMIN });
      expect(get.json().longTerm.maxTokens).toBe(1000);

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

    it("returns 429 with an OpenAI-shaped error once a token window is hit", async () => {
      const userId = await userIdOf(USER);
      await app.inject({
        method: "PUT",
        url: `/admin/limits/${userId}`,
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({ longTerm: { windowSeconds: 3600, maxTokens: 30 } }),
      });

      // First request consumes 30 tokens — allowed (limit checked before).
      const first = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      expect(first.statusCode).toBe(200);

      // Now at the window cap: rejected before reaching server.
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

    it("reports live window consumption in /v1/usage for the dashboard gauges", async () => {
      const userId = await userIdOf(USER);
      await app.inject({
        method: "PUT",
        url: `/admin/limits/${userId}`,
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({
          shortTerm: { windowSeconds: 60, maxRequests: 10 },
          longTerm: { windowSeconds: 86400, maxTokens: 100000 },
        }),
      });

      // Before any traffic under the limit: windows report zero.
      let usage = (await app.inject({ method: "GET", url: "/v1/usage", headers: USER })).json();
      const short0 = usage.window_usage.find((w: { window: string }) => w.window === "shortTerm");
      expect(short0).toMatchObject({ requests: 0, tokens: 0, max_requests: 10 });

      // Send two requests (30 tokens each).
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });

      usage = (await app.inject({ method: "GET", url: "/v1/usage", headers: USER })).json();
      const short = usage.window_usage.find((w: { window: string }) => w.window === "shortTerm");
      const long = usage.window_usage.find((w: { window: string }) => w.window === "longTerm");
      expect(short).toMatchObject({ requests: 2, window_seconds: 60 });
      expect(long).toMatchObject({ tokens: 60, window_seconds: 86400 });
    });
  });

  it("exposes admin usage across users", async () => {
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
    const res = await app.inject({ method: "GET", url: "/admin/usage", headers: ADMIN });
    const body = res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].totals.total_tokens).toBe(30);
    expect(body.users[0].totals.cost_usd).toBeGreaterThan(0);
    expect(body.fleet.total_tokens).toBe(30);
  });

  it("responds to health checks without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  describe("call history + billing", () => {
    it("records successful calls in the user's history with cost", async () => {
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      const res = await app.inject({ method: "GET", url: "/v1/history", headers: USER });
      const body = res.json();
      expect(body.calls).toHaveLength(1);
      expect(body.calls[0]).toMatchObject({ model: "llama3.2:1b", outcome: "ok", total_tokens: 30, streaming: false });
      expect(body.calls[0].cost_usd).toBeGreaterThan(0);
    });

    it("records rejected calls in history without billing them", async () => {
      const userId = (await app.inject({ method: "GET", url: "/v1/usage", headers: USER })).json().user_id;
      await app.inject({
        method: "PUT",
        url: `/admin/limits/${userId}`,
        headers: { ...ADMIN, "content-type": "application/json" },
        payload: JSON.stringify({ longTerm: { windowSeconds: 3600, maxTokens: 30 } }),
      });
      // First succeeds (30 tokens), second is rejected at the window cap.
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      const blocked = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      expect(blocked.statusCode).toBe(429);

      const hist = (await app.inject({ method: "GET", url: "/v1/history", headers: USER })).json();
      const rejected = hist.calls.filter((c: { outcome: string }) => c.outcome === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].cost_usd).toBe(0);
      expect(rejected[0].status_code).toBe(429);
    });

    it("records upstream errors in history without billing", async () => {
      server.respondWith = () => jsonResponse({ error: { message: "model not found" } }, 404);
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      const hist = (await app.inject({ method: "GET", url: "/v1/history", headers: USER })).json();
      expect(hist.calls[0]).toMatchObject({ outcome: "error", status_code: 404, cost_usd: 0 });
    });

    it("lets an admin read any user's history", async () => {
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      const userId = (await app.inject({ method: "GET", url: "/v1/usage", headers: USER })).json().user_id;
      const res = await app.inject({ method: "GET", url: `/admin/history/${userId}`, headers: ADMIN });
      expect(res.statusCode).toBe(200);
      expect(res.json().calls).toHaveLength(1);
    });

    it("exposes the price sheet to admins", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/pricing", headers: ADMIN });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.unit).toBe("usd_per_million_tokens");
      expect(body.models.length).toBeGreaterThan(0);
    });

    it("keeps history private to each user", async () => {
      await app.inject({ method: "POST", url: "/v1/chat/completions", headers: USER, payload: chatPayload });
      const other = await app.inject({
        method: "GET",
        url: "/v1/history",
        headers: { authorization: "Bearer someone-else" },
      });
      expect(other.json().calls).toHaveLength(0);
    });
  });

  describe("dashboards", () => {
    it("serves the landing page and both dashboards as HTML without auth", async () => {
      for (const url of ["/", "/dashboard", "/admin/dashboard"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers["content-type"]).toContain("text/html");
        expect(res.body).toContain("Meter");
      }
    });
  });
});
