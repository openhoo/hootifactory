import type { RegistryModuleId } from "@hootifactory/types";
import { type CompiledRoute, compileRoutes } from "../routing/route-matcher";
import type { RegistryPlugin } from "./adapter";

function aliasRegistryPlugin(plugin: RegistryPlugin, id: RegistryModuleId): RegistryPlugin {
  if (plugin.id === id) return plugin;
  return new Proxy(plugin, {
    get(target, prop, receiver) {
      if (prop === "id") return id;
      if (prop === "displayName") return id;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Holds registry plugins and their pre-compiled route tables. */
export class RegistryPluginRegistry {
  private readonly adapters = new Map<RegistryModuleId, RegistryPlugin>();
  private readonly compiled = new Map<RegistryModuleId, CompiledRoute[]>();

  register(plugin: RegistryPlugin): void {
    this.registerAs(plugin.id, plugin);
  }

  /** Register a plugin under a different module key (e.g. Helm reuses the OCI plugin). */
  registerAs(moduleId: RegistryModuleId, plugin: RegistryPlugin): void {
    this.adapters.set(moduleId, aliasRegistryPlugin(plugin, moduleId));
    this.compiled.set(moduleId, compileRoutes(plugin.routes()));
  }

  lookup(moduleId: RegistryModuleId): RegistryPlugin | undefined {
    return this.adapters.get(moduleId);
  }

  routesFor(moduleId: RegistryModuleId): CompiledRoute[] {
    return this.compiled.get(moduleId) ?? [];
  }

  has(moduleId: RegistryModuleId): boolean {
    return this.adapters.has(moduleId);
  }

  all(): RegistryPlugin[] {
    return [...this.adapters.values()];
  }
}

/** Process-wide plugin registry. */
export const registryPlugins = new RegistryPluginRegistry();
