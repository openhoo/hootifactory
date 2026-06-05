import type { ScannerInputKind, ScannerPlugin } from "./types";

const ENTRY_POINT_BY_KIND: Record<ScannerInputKind, keyof ScannerPlugin> = {
  stream: "createStreamConsumer",
  content: "scanContent",
  dependencies: "scanDependencies",
};

/** Holds the registered scanner plugins and answers queries over the set. */
export class ScannerPluginRegistry {
  private readonly plugins = new Map<string, ScannerPlugin>();
  private readonly derived = new Map<string, unknown>();

  /** Register a scanner plugin under its `id`. Throws on duplicate ids or a missing entry point. */
  register(plugin: ScannerPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`scanner plugin already registered: ${plugin.id}`);
    }
    const entryPoint = ENTRY_POINT_BY_KIND[plugin.capabilities.inputKind];
    if (typeof plugin[entryPoint] !== "function") {
      throw new Error(
        `scanner plugin ${plugin.id} declares inputKind '${plugin.capabilities.inputKind}' but does not implement ${String(entryPoint)}`,
      );
    }
    this.plugins.set(plugin.id, plugin);
    this.derived.clear();
  }

  lookup(id: string): ScannerPlugin | undefined {
    return this.plugins.get(id);
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  all(): ScannerPlugin[] {
    return [...this.plugins.values()];
  }

  /** The registered plugins that consume a given input kind. */
  forInputKind(kind: ScannerInputKind): ScannerPlugin[] {
    return this.derive(`inputKind:${kind}`, () =>
      this.all().filter((plugin) => plugin.capabilities.inputKind === kind),
    );
  }

  /**
   * Memoize data derived from the registered plugin set, which is immutable after
   * bootstrap. The cache is invalidated whenever a plugin is registered.
   */
  derive<T>(key: string, build: () => T): T {
    if (!this.derived.has(key)) this.derived.set(key, build());
    return this.derived.get(key) as T;
  }
}

/** Process-wide scanner plugin registry. */
export const scannerPlugins = new ScannerPluginRegistry();
