import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { identify, parseBearer } from "./auth.js";
import { createStorage, type Storage } from "./store/storage.js";
import { Pricing } from "./billing/pricing.js";
import { Limiter } from "./limits/limiter.js";
import { ModelServer } from "./proxy/model-server.js";
import { ProxyHandler } from "./proxy/proxy-handler.js";
import { registerUsageRoutes } from "./routes/usage-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerUiRoutes } from "./routes/ui-routes.js";
import { openAiError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Composition root: builds the app with all dependencies wired. Kept separate
 * from the process entry point so tests can build an app instance with
 * fastify.inject and a fake model server, without binding a port.
 */
export function buildApp(
  config: Config,
  deps?: { modelServer?: ModelServer; storage?: Storage },
): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    // UUID request ids instead of Fastify's default "req-N" counter: unique
    // across instances and restarts, so logs stay correlatable when the proxy
    // is scaled horizontally or sits behind a load balancer. Honor an
    // upstream-supplied `x-request-id` when present so a trace id set by an
    // edge/gateway carries through this hop.
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      const forwarded = Array.isArray(header) ? header[0] : header;
      return forwarded?.trim() || randomUUID();
    },
    // Under heavy concurrency, don't let slow clients hold sockets forever.
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    bodyLimit: 20 * 1024 * 1024, // vision requests carry base64 images
  });

  const injectedStorage = deps?.storage !== undefined;
  const storage = deps?.storage ?? createStorage(config);
  const { usage: usageStore, limits: limitStore, windows: windowStore, history: historyStore } = storage;
  const pricing = new Pricing();
  const limiter = new Limiter(limitStore, windowStore);
  const modelServer = deps?.modelServer ?? new ModelServer(config);
  const proxy = new ProxyHandler(modelServer, limiter, usageStore, historyStore, pricing);

  // --- authenticated user surface (completions + usage) ---
  app.register(async (userScope) => {
    userScope.addHook("onRequest", async (req, reply) => {
      const token = parseBearer(req.headers.authorization);
      if (!token) {
        reply
          .code(401)
          .send(openAiError("Missing API key. Pass it as a Bearer token.", "missing_api_key", 401));
        return;
      }
      req.userId = identify(token).userId;
    });

    // Register under both /v1/... and bare paths: the OpenAI SDK appends
    // /chat/completions to whatever base_url it is given, so both
    // base_url="http://host:8000" and "http://host:8000/v1" work.
    for (const prefix of ["", "/v1"]) {
      userScope.post(`${prefix}/chat/completions`, (req, reply) =>
        proxy.handleCompletion(req, reply, "/v1/chat/completions"),
      );
      userScope.post(`${prefix}/completions`, (req, reply) =>
        proxy.handleCompletion(req, reply, "/v1/completions"),
      );
      userScope.get(`${prefix}/models`, (req, reply) =>
        proxy.handlePassthrough(req, reply, "/v1/models"),
      );
    }

    registerUsageRoutes(userScope, usageStore, limitStore, historyStore, pricing);
  });

  // --- admin surface (separate auth) ---
  app.register(
    async (adminScope) => {
      registerAdminRoutes(adminScope, config, limitStore, usageStore, historyStore, pricing);
    },
    { prefix: "/admin" },
  );

  // --- dashboards (static HTML; auth happens client-side via the same keys) ---
  registerUiRoutes(app);

  // --- unauthenticated health check (load balancers, monitors) ---
  app.get("/healthz", async () => ({ status: "ok" }));

  app.addHook("onClose", async () => {
    await modelServer.close();
    // Only close storage we created; injected storage is the caller's to manage.
    if (!injectedStorage) storage.close();
  });

  return app;
}
