import { describe, expect, test } from "bun:test";
import { RegistryPluginRegistry } from "@hootifactory/registry";
import { loadConfiguredRegistryPlugins } from "./loader";

describe("loadConfiguredRegistryPlugins", () => {
  test("registers every module id (including aliases) when no allowlist is given", () => {
    const registry = new RegistryPluginRegistry();
    const { registered } = loadConfiguredRegistryPlugins(registry, { enabled: undefined });
    for (const id of ["npm", "docker", "oci", "helm", "pypi", "go", "cargo", "nuget", "rubygems"]) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registered).toContain("oci");
  });

  test("registers primary module ids ahead of aliases, so the module list groups primaries first", () => {
    const registry = new RegistryPluginRegistry();
    const { registered } = loadConfiguredRegistryPlugins(registry, { enabled: undefined });
    // The registry preserves registration order and the UI module dropdown
    // reflects it; primaries must precede the alias module ids.
    expect(registered).toEqual([
      "npm",
      "docker",
      "pypi",
      "go",
      "cargo",
      "nuget",
      "rubygems",
      "oci",
      "helm",
    ]);
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
