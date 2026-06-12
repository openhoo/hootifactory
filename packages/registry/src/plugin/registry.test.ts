import { describe, expect, test } from "bun:test";
import { registryAdapter } from "./plugin";
import { isImmutableContentPath, RegistryPluginRegistry } from "./registry";

const adapter = registryAdapter("npm")
  .module({
    displayName: "npm",
    mountSegment: "npm",
    capabilities: { proxyable: true, virtualizable: true },
  })
  .proxyIngest(() => Promise.resolve(true))
  .routes((route) => [
    route.get("/:pkg+", "packument", () => Response.json({ ok: true })),
    route.put("/:pkg+", "publish", () => Response.json({ ok: true })),
  ])
  .build();

const contentAddressableAdapter = registryAdapter("docker")
  .module({
    displayName: "OCI",
    mountSegment: "v2",
    capabilities: ["contentAddressable", "resumableUploads", "virtualizable"],
  })
  .routes((route) => [
    route.get("/:name+/blobs/:digest", "getBlob", () => Response.json({ ok: true }), {
      immutableContentAddressed: true,
    }),
    route.get("/:name+/manifests/:reference", "getManifest", () => Response.json({ ok: true })),
  ])
  .build();

describe("RegistryPluginRegistry", () => {
  test("registers adapters and compiles their route tables", () => {
    const registry = new RegistryPluginRegistry();

    registry.register(adapter);

    expect(registry.has("npm")).toBe(true);
    expect(registry.lookup("npm")).toBe(adapter);
    expect(registry.routesFor("npm")).toHaveLength(2);
    expect(registry.all()).toEqual([adapter]);
  });

  test("can register one adapter under an alias module id", () => {
    const registry = new RegistryPluginRegistry();

    registry.registerAs("helm", adapter);

    expect(registry.lookup("helm")?.id).toBe("helm");
    expect(registry.lookup("helm")?.routes()).toEqual(adapter.routes());
    expect(registry.has("npm")).toBe(false);
  });
});

describe("isImmutableContentPath", () => {
  const registry = new RegistryPluginRegistry();
  registry.register(contentAddressableAdapter);
  registry.register(adapter);

  test("true for a content-addressable route flagged immutable", () => {
    expect(isImmutableContentPath("/v2/acme/app/blobs/sha256:abcd", registry)).toBe(true);
  });

  test("false for a content-addressable route NOT flagged immutable", () => {
    expect(isImmutableContentPath("/v2/acme/app/manifests/latest", registry)).toBe(false);
  });

  test("false for a non-content-addressable module's path", () => {
    expect(isImmutableContentPath("/npm/acme/left-pad/blobs/sha256:abcd", registry)).toBe(false);
  });

  test("false for a path outside any module mount segment", () => {
    expect(isImmutableContentPath("/api/v1/anything", registry)).toBe(false);
  });

  test("memoized matchers are rebuilt after a new plugin registers", () => {
    const fresh = new RegistryPluginRegistry();
    expect(isImmutableContentPath("/v2/acme/app/blobs/sha256:abcd", fresh)).toBe(false);
    fresh.register(contentAddressableAdapter);
    expect(isImmutableContentPath("/v2/acme/app/blobs/sha256:abcd", fresh)).toBe(true);
  });
});
