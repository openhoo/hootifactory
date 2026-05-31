import { formatRegistry } from "@hootifactory/core";
import { DockerAdapter } from "@hootifactory/format-docker";
import { NpmAdapter } from "@hootifactory/format-npm";
import { PypiAdapter } from "@hootifactory/format-pypi";
import { logger } from "./lib/logger";

/** Register all format adapters (Phase 1: npm, docker/oci, pypi). */
export function registerAdapters(): void {
  formatRegistry.register(new NpmAdapter());
  formatRegistry.register(new DockerAdapter());
  formatRegistry.register(new PypiAdapter());
  logger.info("adapters registered", { formats: formatRegistry.all().map((a) => a.format) });
}
