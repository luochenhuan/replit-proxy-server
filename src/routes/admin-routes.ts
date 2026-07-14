import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { LimitStore } from "../store/limit-store.js";
import type { UsageStore } from "../store/usage-store.js";
import type { CallHistoryStore } from "../store/call-history-store.js";
import type { Pricing } from "../billing/pricing.js";
import { LimitValidationError, validateLimitConfig } from "../limits/limiter.js";
import { buildUsageView } from "../billing/usage-view.js";
import { serializeCalls } from "./call-serializer.js";
import { openAiError } from "../errors.js";

/** Max call-history rows returned in one admin request. */
const HISTORY_LIMIT = 200;

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
  history: CallHistoryStore,
  pricing: Pricing,
): void {
  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    if (token !== config.adminApiKey) {
      reply.code(403).send(openAiError("Admin authorization required.", "forbidden", 403));
    }
  });

  /** Usage + cost overview across all users, with each user's limits inlined. */
  app.get("/usage", async () => {
    const users = usage.userIds().map((userId) => {
      const view = buildUsageView(userId, usage, pricing);
      return { ...view, limits: limits.get(userId) ?? null };
    });
    // Fleet-wide rollup so the admin sees the billing floor at a glance.
    const fleet = users.reduce(
      (acc, u) => {
        acc.total_tokens += u.totals.total_tokens;
        acc.cost_usd += u.totals.cost_usd;
        acc.requests += u.totals.requests;
        return acc;
      },
      { total_tokens: 0, cost_usd: 0, requests: 0, users: users.length },
    );
    fleet.cost_usd = Math.round(fleet.cost_usd * 1e6) / 1e6;
    return { users, fleet };
  });

  /** One user's recent call history (admin drill-down). */
  app.get("/history/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    return {
      user_id: userId,
      calls: serializeCalls(history.recent(userId, HISTORY_LIMIT)),
      total_retained: history.count(userId),
    };
  });

  /** The active price sheet, so the admin UI can show the billing basis. */
  app.get("/pricing", async () => {
    return { unit: "usd_per_million_tokens", models: pricing.entries() };
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
