import { env } from "@hootifactory/config";
import { type RegistryPluginRegistry, registryPlugins } from "@hootifactory/registry";
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
  for (const entry of REGISTRY_PLUGIN_MANIFEST) {
    for (const moduleId of [entry.plugin.id, ...(entry.aliases ?? [])]) {
      manifestModuleIds.add(moduleId);
      if (allowed && !allowed.has(moduleId)) continue;
      if (registry.has(moduleId)) continue;
      // registerAs(plugin.id, plugin) is equivalent to register(plugin), so this
      // one call handles both primary ids and aliases.
      registry.registerAs(moduleId, entry.plugin);
      registered.push(moduleId);
    }
  }
  const unknown = allowed ? [...allowed].filter((id) => !manifestModuleIds.has(id)) : [];
  return { registered, unknown };
}
