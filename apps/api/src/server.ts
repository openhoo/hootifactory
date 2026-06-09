import { bootstrapSystemAdmins, sweepExpiredAuthThrottleBuckets } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { shutdownObservability } from "@hootifactory/observability";
import { stopBoss } from "@hootifactory/queue";
import { app } from "./app";
import { registerAdapters } from "./bootstrap";
import { logger } from "./lib/logger";
import { errorMessage } from "./validation";

registerAdapters();

const adminBootstrap = await bootstrapSystemAdmins(env.AUTH_SYSTEM_ADMIN_USER_IDS);
if (adminBootstrap.granted.length > 0 || adminBootstrap.revoked.length > 0) {
  logger.info("system admin bootstrap reconciled", {
    granted: adminBootstrap.granted.length,
    revoked: adminBootstrap.revoked.length,
  });
}
if (adminBootstrap.missing.length > 0) {
  logger.warn("system admin bootstrap references unknown user ids", {
    missing: adminBootstrap.missing,
  });
}

const authThrottleSweepTimer = setInterval(() => {
  void sweepExpiredAuthThrottleBuckets()
    .then((deleted) => {
      if (deleted > 0) logger.debug("expired auth throttle buckets swept", { deleted });
    })
    .catch((err) => {
      logger.warn("expired auth throttle bucket sweep failed", { error: errorMessage(err) });
    });
}, env.AUTH_THROTTLE_SWEEP_INTERVAL_SECONDS * 1000);
authThrottleSweepTimer.unref?.();

const server = Bun.serve({
  port: env.API_PORT,
  hostname: env.API_HOST,
  // Adapters currently buffer uploads before storing them; keep the server
  // ceiling explicit and aligned with the API's early Content-Length guard.
  maxRequestBodySize: env.REGISTRY_MAX_UPLOAD_BYTES,
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
    clearInterval(authThrottleSweepTimer);
    await server.stop();
    await stopBoss();
    await shutdownObservability();
  } catch (err) {
    logger.error("error during shutdown", {
      error: errorMessage(err),
    });
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
