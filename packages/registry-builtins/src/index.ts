import { type RegistryPluginRegistry, registryPlugins } from "@hootifactory/registry";
import { CargoAdapter } from "@hootifactory/registry-cargo";
import { GoAdapter } from "@hootifactory/registry-go";
import { NpmAdapter } from "@hootifactory/registry-npm";
import { NugetAdapter } from "@hootifactory/registry-nuget";
import { DockerAdapter } from "@hootifactory/registry-oci";
import { PypiAdapter } from "@hootifactory/registry-pypi";

/** Register the built-in Hootifactory registry plugins. */
export function registerBuiltInRegistryPlugins(registry: RegistryPluginRegistry = registryPlugins) {
  registry.register(new NpmAdapter());
  registry.register(new DockerAdapter());
  registry.register(new PypiAdapter());
  registry.register(new GoAdapter());
  registry.register(new CargoAdapter());
  registry.register(new NugetAdapter());
  registry.registerAs("oci", new DockerAdapter());
  registry.registerAs("helm", new DockerAdapter());
}
