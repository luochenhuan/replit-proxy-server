import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

/**
 * Process entry point: load config, start the server, wire graceful shutdown.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close(); // stops accepting; lets in-flight requests finish
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
