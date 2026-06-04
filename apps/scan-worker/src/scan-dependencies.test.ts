import { describe, expect, test } from "bun:test";
import type { RegistryPlugin } from "@hootifactory/registry";
import { collectPackageDependencies } from "./scan-dependencies";

function moduleWithScan(scan: RegistryPlugin["scan"]): RegistryPlugin {
  return {
    id: "test",
    displayName: "Test",
    mountSegment: "test",
    apiKeyHeaders: new Set(),
    errorResponseKind: "registry",
    compressibleHandlers: new Set(),
    compressibleContentTypes: new Set(),
    scan,
    capabilities: {
      contentAddressable: false,
      resumableUploads: false,
      proxyable: false,
      virtualizable: false,
    },
    routes: () => [],
    requiredPermission: () => ({ action: "read" }),
    handle: async () => new Response(null),
  };
}

describe("scan dependency collection", () => {
  test("returns module default ecosystem when there is no version payload to inspect", async () => {
    await expect(
      collectPackageDependencies({
        repositoryId: "repo_1",
        module: moduleWithScan({ defaultOsvEcosystem: "Example" }),
        artifactName: null,
        artifactVersion: null,
      }),
    ).resolves.toEqual({
      deps: {},
      osvEcosystem: "Example",
    });
  });

  test("stays generic when a module has no scan provider", async () => {
    await expect(
      collectPackageDependencies({
        repositoryId: "repo_1",
        module: moduleWithScan(undefined),
        artifactName: "package",
        artifactVersion: "1.0.0",
      }),
    ).resolves.toEqual({
      deps: {},
      osvEcosystem: "",
    });
  });
});
