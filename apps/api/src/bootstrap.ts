import { formatRegistry } from "@hootifactory/core";
import { logger } from "./lib/logger";

/**
 * Register all format adapters. Phase 1 adds npm, docker/oci, and pypi here.
 */
export function registerAdapters(): void {
  // (Phase 1) formatRegistry.register(new NpmAdapter());
  // (Phase 1) formatRegistry.register(new DockerAdapter());
  // (Phase 1) formatRegistry.register(new PypiAdapter());
  logger.info("adapters registered", { formats: formatRegistry.all().map((a) => a.format) });
}
