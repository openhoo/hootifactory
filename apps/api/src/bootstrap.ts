import { formatRegistry } from "@hootifactory/core";
import { CargoAdapter } from "@hootifactory/format-cargo";
import { DockerAdapter } from "@hootifactory/format-docker";
import { GoAdapter } from "@hootifactory/format-go";
import { NpmAdapter } from "@hootifactory/format-npm";
import { NugetAdapter } from "@hootifactory/format-nuget";
import { PypiAdapter } from "@hootifactory/format-pypi";
import { logger } from "./lib/logger";

/** Register all format adapters (Helm + OCI reuse the Docker adapter). */
export function registerAdapters(): void {
  formatRegistry.register(new NpmAdapter());
  formatRegistry.register(new DockerAdapter());
  formatRegistry.register(new PypiAdapter());
  formatRegistry.register(new GoAdapter());
  formatRegistry.register(new CargoAdapter());
  formatRegistry.register(new NugetAdapter());
  formatRegistry.registerAs("oci", new DockerAdapter());
  formatRegistry.registerAs("helm", new DockerAdapter());
  logger.info("adapters registered", { formats: formatRegistry.all().map((a) => a.format) });
}
