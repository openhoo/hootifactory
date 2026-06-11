import { describe, expect, test } from "bun:test";
import { RegistryPluginRegistry } from "@hootifactory/registry";
import { loadConfiguredRegistryPlugins } from "./loader";
import { REGISTRY_PLUGIN_MANIFEST } from "./manifest";

// Expectations are derived from the manifest so adding a plugin (or alias) is a
// manifest-only change — this test asserts the loader's RULES (membership,
// primaries-before-aliases ordering, allowlist semantics), not a hand-maintained
// id list that every new plugin would have to edit.
const primaryIds = REGISTRY_PLUGIN_MANIFEST.map((entry) => entry.plugin.id);
const aliasIds = REGISTRY_PLUGIN_MANIFEST.flatMap((entry) => entry.aliases ?? []);

describe("loadConfiguredRegistryPlugins", () => {
  test("the manifest has unique module ids across primaries and aliases", () => {
    const all = [...primaryIds, ...aliasIds];
    expect(new Set(all).size).toBe(all.length);
    // Canary against an accidentally emptied manifest: the flagship module ids
    // (and the OCI plugin's alias wiring) must exist.
    expect(primaryIds).toContain("npm");
    expect(primaryIds).toContain("docker");
    expect(aliasIds).toContain("oci");
    expect(aliasIds).toContain("helm");
  });

  test("registers every manifest module id, primaries ahead of aliases", () => {
    const registry = new RegistryPluginRegistry();
    const { registered, unknown } = loadConfiguredRegistryPlugins(registry, {
      enabled: undefined,
    });
    for (const id of [...primaryIds, ...aliasIds]) {
      expect(registry.has(id)).toBe(true);
    }
    // The registry preserves registration order and the UI module dropdown
    // reflects it; every primary id must precede every alias module id.
    expect(registered).toEqual([...primaryIds, ...aliasIds]);
    expect(unknown).toEqual([]);
  });

  test("honors the allowlist over module ids including aliases", () => {
    const registry = new RegistryPluginRegistry();
    const { registered, unknown } = loadConfiguredRegistryPlugins(registry, {
      enabled: ["npm", "oci", "bogus"],
    });
    expect(registry.has("npm")).toBe(true);
    expect(registry.has("oci")).toBe(true);
    // docker (the OCI plugin's primary id) and helm were not allowlisted.
    expect(registry.has("docker")).toBe(false);
    expect(registry.has("helm")).toBe(false);
    expect(registered.sort()).toEqual(["npm", "oci"]);
    expect(unknown).toEqual(["bogus"]);
  });
});
