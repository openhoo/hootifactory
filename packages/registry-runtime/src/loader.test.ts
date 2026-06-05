import { describe, expect, test } from "bun:test";
import { RegistryPluginRegistry } from "@hootifactory/registry";
import { loadConfiguredRegistryPlugins } from "./loader";

describe("loadConfiguredRegistryPlugins", () => {
  test("registers every module id (including aliases) when no allowlist is given", () => {
    const registry = new RegistryPluginRegistry();
    const { registered } = loadConfiguredRegistryPlugins(registry, { enabled: undefined });
    for (const id of ["npm", "docker", "oci", "helm", "pypi", "go", "cargo", "nuget"]) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registered).toContain("oci");
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
