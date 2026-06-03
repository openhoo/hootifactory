import { type RegistryPluginRegistry, registryPlugins } from "@hootifactory/registry";
import { cargoRegistryPlugin } from "@hootifactory/registry-cargo";
import { goRegistryPlugin } from "@hootifactory/registry-go";
import { npmRegistryPlugin } from "@hootifactory/registry-npm";
import { nugetRegistryPlugin } from "@hootifactory/registry-nuget";
import { dockerRegistryPlugin } from "@hootifactory/registry-oci";
import { pypiRegistryPlugin } from "@hootifactory/registry-pypi";

/** Register the built-in Hootifactory registry plugins. */
export function registerBuiltInRegistryPlugins(registry: RegistryPluginRegistry = registryPlugins) {
  registry.register(npmRegistryPlugin);
  registry.register(dockerRegistryPlugin);
  registry.register(pypiRegistryPlugin);
  registry.register(goRegistryPlugin);
  registry.register(cargoRegistryPlugin);
  registry.register(nugetRegistryPlugin);
  registry.registerAs("oci", dockerRegistryPlugin);
  registry.registerAs("helm", dockerRegistryPlugin);
}
