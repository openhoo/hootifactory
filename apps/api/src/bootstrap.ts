import { registryPlugins } from "@hootifactory/registry";
import { registerBuiltInRegistryPlugins } from "@hootifactory/registry-builtins";
import { logger } from "./lib/logger";

/** Register all built-in registry plugins (Helm + OCI reuse the Docker plugin). */
export function registerAdapters(): void {
  registerBuiltInRegistryPlugins(registryPlugins);
  logger.info("registry plugins registered", {
    formats: registryPlugins.all().map((plugin) => plugin.format),
  });
}
