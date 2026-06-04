import { describe, expect, test } from "bun:test";
import { registryPlugin } from "./plugin";
import { RegistryPluginRegistry } from "./registry";

const adapter = registryPlugin("npm")
  .module({ displayName: "npm", mountSegment: "npm" })
  .capabilities({ proxyable: true, virtualizable: true })
  .get("/:pkg+", "packument", () => Response.json({ ok: true }))
  .put("/:pkg+", "publish", () => Response.json({ ok: true }))
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
