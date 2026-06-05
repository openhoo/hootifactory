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
  private readonly derived = new Map<string, unknown>();

  register(plugin: RegistryPlugin): void {
    this.registerAs(plugin.id, plugin);
  }

  /** Register a plugin under a different module key (e.g. Helm reuses the OCI plugin). */
  registerAs(moduleId: RegistryModuleId, plugin: RegistryPlugin): void {
    this.adapters.set(moduleId, aliasRegistryPlugin(plugin, moduleId));
    this.compiled.set(moduleId, compileRoutes(plugin.routes()));
    this.derived.clear();
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

  /**
   * Memoize data derived from the registered plugin set, which is immutable
   * after bootstrap. The cache is invalidated whenever a plugin is
   * (re)registered, so hot-path consumers can avoid rescanning every plugin on
   * each request/response.
   */
  derive<T>(key: string, build: () => T): T {
    if (!this.derived.has(key)) this.derived.set(key, build());
    return this.derived.get(key) as T;
  }
}

/** Process-wide plugin registry. */
export const registryPlugins = new RegistryPluginRegistry();

/**
 * Whether an absolute request path serves immutable, content-addressed bytes,
 * derived from the registered content-addressable modules' route tables (routes
 * flagged `immutableContentAddressed`). Lets agnostic middleware long-cache such
 * responses without knowing any module's URL grammar.
 *
 * Invariant: the path is matched against each route's regex after stripping only
 * the leading `/<mountSegment>`, so the repo's org/name segments remain in the
 * tested string. An `immutableContentAddressed` route must therefore begin with
 * a greedy param (e.g. `/:name+/...`) that absorbs them — which OCI's
 * `/:name+/blobs/:digest` does.
 */
export function isImmutableContentPath(
  pathname: string,
  registry: RegistryPluginRegistry = registryPlugins,
): boolean {
  // Precompute (once per plugin-set) the content-addressable modules' mount
  // prefixes and their immutable-content routes, so the hot response path only
  // does prefix checks + regex tests.
  const matchers = registry.derive("immutableContentMatchers", () =>
    registry
      .all()
      .filter((plugin) => plugin.capabilities.contentAddressable)
      .map((plugin) => ({
        prefix: `/${plugin.mountSegment}`,
        routes: registry
          .routesFor(plugin.id)
          .filter((route) => route.entry.immutableContentAddressed),
      }))
      .filter((matcher) => matcher.routes.length > 0),
  );
  for (const matcher of matchers) {
    if (!pathname.startsWith(`${matcher.prefix}/`)) continue;
    const relative = pathname.slice(matcher.prefix.length);
    for (const route of matcher.routes) {
      if (route.regex.test(relative)) return true;
    }
  }
  return false;
}
