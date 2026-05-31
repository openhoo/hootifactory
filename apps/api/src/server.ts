import { env } from "@hootifactory/config";
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
