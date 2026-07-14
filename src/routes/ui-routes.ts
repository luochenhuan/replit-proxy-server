import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Serves the two dashboards as self-contained HTML pages.
 *
 * The pages hold no secrets — they prompt for the user token / admin key in
 * the browser and call the JSON APIs directly — so they are served without
 * auth. All authorization still happens on the API routes those pages call.
 *
 * Files are read once at startup (there are only two, and they never change
 * at runtime), avoiding a per-request disk hit and a static-file dependency.
 */
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

function loadPage(file: string): string {
  return readFileSync(join(publicDir, file), "utf8");
}

export function registerUiRoutes(app: FastifyInstance): void {
  const userPage = loadPage("user.html");
  const adminPage = loadPage("admin.html");
  const indexPage = loadPage("index.html");

  const html = (body: string) => (_req: unknown, reply: { type: (t: string) => { send: (b: string) => void } }) =>
    reply.type("text/html; charset=utf-8").send(body);

  app.get("/", html(indexPage));
  app.get("/dashboard", html(userPage));
  app.get("/admin/dashboard", html(adminPage));
}
