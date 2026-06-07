import { describe, expect, test } from "bun:test";
import { registryPlugin } from "./plugin";
import {
  isImmutableContentPath,
  isRegistryMountPath,
  RegistryPluginRegistry,
  registryPlugins,
} from "./registry";

const npm = registryPlugin("npm")
  .module({ displayName: "npm", mountSegment: "npm" })
  .capabilities("proxyable", "virtualizable")
  .get("/:pkg+", "packument", () => Response.json({ ok: true }))
  .build();

describe("RegistryPluginRegistry — additional behavior", () => {
  test("register is idempotent on the alias proxy (same id returns the plugin itself)", () => {
    const registry = new RegistryPluginRegistry();
    registry.registerAs("npm", npm);
    // npm.id === "npm" so aliasRegistryPlugin returns the original (no proxy).
    expect(registry.lookup("npm")).toBe(npm);
  });

  test("routesFor returns an empty array for an unknown module", () => {
    const registry = new RegistryPluginRegistry();
    expect(registry.routesFor("npm")).toEqual([]);
  });

  test("derive memoizes a built value and invalidates it on (re)register", () => {
    const registry = new RegistryPluginRegistry();
    let builds = 0;
    const build = () => {
      builds += 1;
      return registry.all().length;
    };
    expect(registry.derive("count", build)).toBe(0);
    expect(registry.derive("count", build)).toBe(0);
    expect(builds).toBe(1);

    registry.register(npm);
    expect(registry.derive("count", build)).toBe(1);
    expect(builds).toBe(2);
  });

  test("the process-wide registryPlugins singleton is a RegistryPluginRegistry", () => {
    expect(registryPlugins).toBeInstanceOf(RegistryPluginRegistry);
  });
});

describe("isRegistryMountPath", () => {
  const registry = new RegistryPluginRegistry();
  registry.register(npm);

  test("true for a path beneath a registered mount segment", () => {
    expect(isRegistryMountPath("/npm/acme/left-pad", registry)).toBe(true);
  });

  test("false for the bare mount prefix itself", () => {
    expect(isRegistryMountPath("/npm/", registry)).toBe(false);
  });

  test("false for a path outside any registered mount segment", () => {
    expect(isRegistryMountPath("/api/v1/health", registry)).toBe(false);
  });

  test("false when no plugins are registered, then true after registering", () => {
    const fresh = new RegistryPluginRegistry();
    expect(isRegistryMountPath("/npm/acme/left-pad", fresh)).toBe(false);
    fresh.register(npm);
    expect(isRegistryMountPath("/npm/acme/left-pad", fresh)).toBe(true);
  });
});

describe("isImmutableContentPath — content-addressable module with no immutable routes", () => {
  test("false when a content-addressable module declares no immutable routes", () => {
    const registry = new RegistryPluginRegistry();
    const caNoImmutable = registryPlugin("docker")
      .module({ mountSegment: "v2" })
      .capabilities("contentAddressable")
      .get("/:name+/manifests/:reference", "getManifest", () => Response.json({ ok: true }))
      .build();
    registry.register(caNoImmutable);
    expect(isImmutableContentPath("/v2/acme/app/manifests/latest", registry)).toBe(false);
  });
});
