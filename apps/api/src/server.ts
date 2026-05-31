import { env } from "@hootifactory/config";
import { stopBoss } from "@hootifactory/queue";
import { app } from "./app";
import { registerAdapters } from "./bootstrap";
import { logger } from "./lib/logger";

registerAdapters();

const server = Bun.serve({
  port: env.API_PORT,
  hostname: env.API_HOST,
  // allow large layer/tarball uploads (10 GiB)
  maxRequestBodySize: 10 * 1024 * 1024 * 1024,
  idleTimeout: 120,
  fetch: app.fetch,
});

logger.info("hootifactory api listening", {
  url: `http://${env.API_HOST}:${server.port}`,
  publicUrl: env.REGISTRY_PUBLIC_URL,
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish (server.stop() with no arg is the graceful form), then drain pg-boss.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  try {
    await server.stop();
    await stopBoss();
  } catch (err) {
    logger.error("error during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
