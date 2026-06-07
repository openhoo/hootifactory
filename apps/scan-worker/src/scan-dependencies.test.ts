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

/**
 * Build a fake `db` handle (injected through collectPackageDependencies' `db`
 * seam — never via process-global `mock.module`, which raced the real handle in
 * CI) with a chainable select builder whose awaited result is taken from a queue,
 * so collectPackageDependencies can be driven through the package + version
 * metadata lookups without a database.
 */
function makeDb(selectResults: unknown[][]): typeof import("@hootifactory/db").db {
  let call = 0;
  function chain(): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = selectResults[call] ?? [];
            call += 1;
            return (resolve: (v: unknown) => unknown) => resolve(value);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  return { select: () => chain() } as unknown as typeof import("@hootifactory/db").db;
}

describe("scan dependency collection", () => {
  test("returns module default ecosystem when there is no version payload to inspect", async () => {
    await expect(
      collectPackageDependencies({
        repositoryId: "repo_1",
        module: moduleWithScan({ defaultOsvEcosystem: "Example" }),
        artifactName: null,
        artifactVersion: null,
        db: makeDb([]),
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
        db: makeDb([]),
      }),
    ).resolves.toEqual({
      deps: {},
      osvEcosystem: "",
    });
  });

  test("resolves dependency graph from stored version metadata", async () => {
    const scan: RegistryPlugin["scan"] = {
      defaultOsvEcosystem: "npm",
      dependencyGraph: ({ metadata }) => {
        const deps = (metadata as { dependencies?: Record<string, string> }).dependencies ?? {};
        return { deps, osvEcosystem: "npm", purlType: "npm" };
      },
    };

    await expect(
      collectPackageDependencies({
        repositoryId: "repo_1",
        module: moduleWithScan(scan),
        artifactName: "package",
        artifactVersion: "1.0.0",
        // First select returns the package row, second the version metadata.
        db: makeDb([[{ id: "pkg_1" }], [{ metadata: { dependencies: { leftpad: "1.2.3" } } }]]),
      }),
    ).resolves.toEqual({
      deps: { leftpad: "1.2.3" },
      osvEcosystem: "npm",
      purlType: "npm",
    });
  });

  test("falls back to the module default ecosystem when the graph omits one", async () => {
    const scan: RegistryPlugin["scan"] = {
      defaultOsvEcosystem: "Packagist",
      dependencyGraph: () => ({ deps: { acme: "^1" } }),
    };

    await expect(
      collectPackageDependencies({
        repositoryId: "repo_1",
        module: moduleWithScan(scan),
        artifactName: "package",
        artifactVersion: "2.0.0",
        db: makeDb([[{ id: "pkg_1" }], [{ metadata: {} }]]),
      }),
    ).resolves.toEqual({
      deps: { acme: "^1" },
      osvEcosystem: "Packagist",
      purlType: undefined,
    });
  });

  test("returns defaults when the package row is missing", async () => {
    const scan: RegistryPlugin["scan"] = {
      defaultOsvEcosystem: "npm",
      dependencyGraph: () => ({ deps: { should: "not-run" } }),
    };

    await expect(
      collectPackageDependencies({
        repositoryId: "repo_1",
        module: moduleWithScan(scan),
        artifactName: "package",
        artifactVersion: "1.0.0",
        // No package row → loadPackageVersionMetadata returns null, graph never runs.
        db: makeDb([[]]),
      }),
    ).resolves.toEqual({
      deps: {},
      osvEcosystem: "npm",
    });
  });

  test("treats invalid version metadata as an empty record", async () => {
    const seen: unknown[] = [];
    const scan: RegistryPlugin["scan"] = {
      defaultOsvEcosystem: "npm",
      dependencyGraph: ({ metadata }) => {
        seen.push(metadata);
        return { deps: {}, osvEcosystem: "npm" };
      },
    };

    // Package found, but the version row has non-object metadata: the safeParse
    // fallback yields {} so the graph sees an empty metadata object.
    await collectPackageDependencies({
      repositoryId: "repo_1",
      module: moduleWithScan(scan),
      artifactName: "package",
      artifactVersion: "1.0.0",
      db: makeDb([[{ id: "pkg_1" }], [{ metadata: "not-an-object" }]]),
    });
    expect(seen).toEqual([{}]);
  });
});
