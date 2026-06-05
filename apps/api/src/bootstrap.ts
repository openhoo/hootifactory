import { registryPlugins } from "@hootifactory/registry";
import { loadConfiguredRegistryPlugins } from "@hootifactory/registry-runtime";
import { logger } from "./lib/logger";

/**
 * Register the configured registry plugins (the operator allowlist REGISTRY_PLUGINS
 * narrows the built-in set; unset = all). Helm + OCI reuse the Docker plugin via
 * module-id aliases declared in the runtime manifest, not here.
 */
export function registerAdapters(): void {
  const { unknown } = loadConfiguredRegistryPlugins(registryPlugins);
  if (unknown.length > 0) {
    logger.warn("ignoring unknown registry plugins in REGISTRY_PLUGINS", { unknown });
  }
  logger.info("registry plugins registered", {
    modules: registryPlugins.all().map((plugin) => plugin.id),
  });
}
