import { describe, expect, test } from "bun:test";
import { RegistryPluginRegistry } from "@hootifactory/registry";
import { loadConfiguredRegistryPlugins, REGISTRY_PLUGIN_MANIFEST } from "./index";

describe("registry-runtime package entry", () => {
  test("re-exports the manifest and loader through the package barrel", () => {
    expect(Array.isArray(REGISTRY_PLUGIN_MANIFEST)).toBe(true);
    expect(REGISTRY_PLUGIN_MANIFEST.length).toBeGreaterThan(0);
    expect(typeof loadConfiguredRegistryPlugins).toBe("function");

    const registry = new RegistryPluginRegistry();
    const { registered, unknown } = loadConfiguredRegistryPlugins(registry, { enabled: ["npm"] });
    expect(registered).toEqual(["npm"]);
    expect(unknown).toEqual([]);
    expect(registry.has("npm")).toBe(true);
  });
});
