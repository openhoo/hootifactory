import { describe, expect, test } from "bun:test";
import * as registry from "./index";

describe("@hootifactory/registry barrel", () => {
  test("re-exports the registry SDK public surface", () => {
    // Plugin builders / factories.
    expect(typeof registry.registryPlugin).toBe("function");
    expect(typeof registry.registryAdapter).toBe("function");
    expect(typeof registry.defineRegistryPlugin).toBe("function");
    expect(typeof registry.delegateRegistryPlugin).toBe("function");
    expect(typeof registry.registryCapabilities).toBe("function");
    expect(typeof registry.registryScan).toBe("function");
    expect(typeof registry.registryRoute).toBe("function");

    // Permission helpers.
    expect(typeof registry.readWritePermission).toBe("function");
    expect(typeof registry.readOnlyPermission).toBe("function");
    expect(typeof registry.writePermission).toBe("function");
    expect(typeof registry.deletePermission).toBe("function");
    expect(typeof registry.registryPermissions).toBe("object");

    // Auth / errors / routing / helpers.
    expect(typeof registry.basicAuthChallenge).toBe("function");
    expect(typeof registry.bearerAuthChallenge).toBe("function");
    expect(typeof registry.registryBearerAuthChallenge).toBe("function");
    expect(typeof registry.registryErrorResponseForModule).toBe("function");
    expect(typeof registry.compileRoutes).toBe("function");
    expect(typeof registry.matchRoute).toBe("function");
    expect(typeof registry.serveRegistryBlob).toBe("function");
    expect(typeof registry.textResponseWithEtag).toBe("function");

    // Re-exported core utilities stay reachable from the SDK entrypoint.
    expect(typeof registry.computeDigest).toBe("function");
    expect(typeof registry.isValidDigest).toBe("function");
    expect(typeof registry.RegistryError).toBe("function");
    expect(typeof registry.z).toBe("object");
  });

  test("exposes a usable plugin factory through the barrel", () => {
    const plugin = registry
      .registryPlugin("npm")
      .capabilities("virtualizable")
      .get("/:pkg+", "packument", () => Response.json({ ok: true }))
      .build();

    expect(plugin.id).toBe("npm");
    expect(plugin.routes()).toHaveLength(1);
  });
});
