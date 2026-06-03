import type { PackageFormat } from "@hootifactory/types";
import { type CompiledRoute, compileRoutes } from "../routing/route-matcher";
import type { RegistryPlugin } from "./adapter";

/** Holds registry plugins and their pre-compiled route tables. */
export class RegistryPluginRegistry {
  private readonly adapters = new Map<PackageFormat, RegistryPlugin>();
  private readonly compiled = new Map<PackageFormat, CompiledRoute[]>();

  register(plugin: RegistryPlugin): void {
    this.registerAs(plugin.format, plugin);
  }

  /** Register a plugin under a different format key (e.g. Helm reuses the OCI plugin). */
  registerAs(format: PackageFormat, plugin: RegistryPlugin): void {
    this.adapters.set(format, plugin);
    this.compiled.set(format, compileRoutes(plugin.routes()));
  }

  lookup(format: PackageFormat): RegistryPlugin | undefined {
    return this.adapters.get(format);
  }

  routesFor(format: PackageFormat): CompiledRoute[] {
    return this.compiled.get(format) ?? [];
  }

  has(format: PackageFormat): boolean {
    return this.adapters.has(format);
  }

  all(): RegistryPlugin[] {
    return [...this.adapters.values()];
  }
}

/** @deprecated Use RegistryPluginRegistry for new code. */
export class FormatRegistry extends RegistryPluginRegistry {}

/** Process-wide plugin registry. */
export const registryPlugins = new RegistryPluginRegistry();

/** @deprecated Use registryPlugins for new code. */
export const formatRegistry = registryPlugins;
