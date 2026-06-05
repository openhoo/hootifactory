import { env } from "@hootifactory/config";
import {
  type RegistryPlugin,
  type RegistryPluginRegistry,
  registryPlugins,
} from "@hootifactory/registry";
import { REGISTRY_PLUGIN_MANIFEST } from "./manifest";

export interface LoadRegistryPluginsResult {
  /** Module ids registered into the registry (primary ids and aliases). */
  registered: string[];
  /** Allowlist entries that matched no manifest module id (operator typos). */
  unknown: string[];
}

/**
 * Register the built-in registry plugins into `registry`, filtered by the
 * operator allowlist. An unset allowlist (the default) registers every module id
 * — identical to the previous always-register behavior — so existing deployments
 * are unaffected; `REGISTRY_PLUGINS=npm,oci` narrows the set. The allowlist
 * matches module ids, so an alias (`oci`, `helm`) can be enabled independently of
 * its plugin's primary id.
 */
export function loadConfiguredRegistryPlugins(
  registry: RegistryPluginRegistry = registryPlugins,
  options: { enabled?: readonly string[] } = {},
): LoadRegistryPluginsResult {
  const enabled = options.enabled ?? env.REGISTRY_PLUGINS;
  const allowed = enabled ? new Set(enabled) : null;
  const manifestModuleIds = new Set<string>();
  const registered: string[] = [];
  const registerModule = (moduleId: string, plugin: RegistryPlugin) => {
    manifestModuleIds.add(moduleId);
    if (allowed && !allowed.has(moduleId)) return;
    if (registry.has(moduleId)) return;
    // registerAs(plugin.id, plugin) is equivalent to register(plugin), so this
    // one call handles both primary ids and aliases.
    registry.registerAs(moduleId, plugin);
    registered.push(moduleId);
  };
  // Register every plugin's primary module id first, then every alias, so the
  // registered order — which the registry preserves and the user-facing module
  // list reflects — groups the primary formats ahead of alias module ids,
  // matching the pre-plugin registration order the UI depends on.
  for (const entry of REGISTRY_PLUGIN_MANIFEST) {
    registerModule(entry.plugin.id, entry.plugin);
  }
  for (const entry of REGISTRY_PLUGIN_MANIFEST) {
    for (const alias of entry.aliases ?? []) {
      registerModule(alias, entry.plugin);
    }
  }
  const unknown = allowed ? [...allowed].filter((id) => !manifestModuleIds.has(id)) : [];
  return { registered, unknown };
}
