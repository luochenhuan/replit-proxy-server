import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { LimitStore } from "../store/limit-store.js";
import type { UsageStore } from "../store/usage-store.js";
import { LimitValidationError, validateLimitConfig } from "../limits/limiter.js";
import { openAiError } from "../errors.js";

/**
 * Admin API, guarded by a dedicated admin key (separate trust domain from
 * user tokens). Manages per-user limits and exposes usage across all users.
 *
 * Users are addressed by their opaque userId (as returned by /v1/usage and
 * GET /admin/usage), never by raw API token.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  config: Config,
  limits: LimitStore,
  usage: UsageStore,
): void {
  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    if (token !== config.adminApiKey) {
      reply.code(403).send(openAiError("Admin authorization required.", "forbidden", 403));
    }
  });

  /** Usage overview across all users. */
  app.get("/usage", async () => {
    const users = usage.userIds().map((userId) => {
      const byModel = usage.totalsByModel(userId);
      const models: Record<string, unknown> = {};
      for (const [model, agg] of byModel) {
        models[model] = {
          prompt_tokens: agg.promptTokens,
          completion_tokens: agg.completionTokens,
          total_tokens: agg.totalTokens,
          requests: agg.requests,
        };
      }
      return { user_id: userId, total_tokens: usage.totalTokens(userId), models };
    });
    return { users };
  });

  /** List all configured limits. */
  app.get("/limits", async () => {
    return { limits: limits.entries().map(({ userId, config: c }) => ({ user_id: userId, ...c })) };
  });

  /** Read one user's limits. */
  app.get("/limits/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const config = limits.get(userId);
    if (!config) {
      reply.code(404).send(openAiError(`No limits configured for ${userId}.`, "not_found", 404));
      return;
    }
    return { user_id: userId, ...config };
  });

  /** Create/replace a user's limits. */
  app.put("/limits/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    let config;
    try {
      config = validateLimitConfig(req.body);
    } catch (err) {
      if (err instanceof LimitValidationError) {
        reply.code(400).send(openAiError(err.message, "invalid_limit_config", 400));
        return;
      }
      throw err;
    }
    limits.set(userId, config);
    return { user_id: userId, ...config };
  });

  /** Remove a user's limits entirely (back to unlimited). */
  app.delete("/limits/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (!limits.delete(userId)) {
      reply.code(404).send(openAiError(`No limits configured for ${userId}.`, "not_found", 404));
      return;
    }
    reply.code(204).send();
  });
}
