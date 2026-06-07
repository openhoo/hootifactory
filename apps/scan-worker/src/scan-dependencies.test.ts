import { afterEach, describe, expect, mock, test } from "bun:test";
import type { RegistryPlugin } from "@hootifactory/registry";

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
 * Stub the `@hootifactory/db` `db` handle with a chainable select builder whose
 * awaited result is taken from a queue, so collectPackageDependencies can be driven
 * through the package + version metadata lookups without a database.
 */
function makeDb(selectResults: unknown[][]): unknown {
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
  return { select: () => chain() };
}

async function loadModule(dbStub: unknown) {
  const real = await import("@hootifactory/db");
  await mock.module("@hootifactory/db", () => ({ ...real, db: dbStub }));
  return import("./scan-dependencies");
}

afterEach(() => {
  mock.restore();
});

describe("scan dependency collection", () => {
  test("returns module default ecosystem when there is no version payload to inspect", async () => {
    const { collectPackageDependencies } = await loadModule(makeDb([]));
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
    const { collectPackageDependencies } = await loadModule(makeDb([]));
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

  test("resolves dependency graph from stored version metadata", async () => {
    // First select returns the package row, second returns the version metadata.
    const { collectPackageDependencies } = await loadModule(
      makeDb([[{ id: "pkg_1" }], [{ metadata: { dependencies: { leftpad: "1.2.3" } } }]]),
    );

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
      }),
    ).resolves.toEqual({
      deps: { leftpad: "1.2.3" },
      osvEcosystem: "npm",
      purlType: "npm",
    });
  });

  test("falls back to the module default ecosystem when the graph omits one", async () => {
    const { collectPackageDependencies } = await loadModule(
      makeDb([[{ id: "pkg_1" }], [{ metadata: {} }]]),
    );

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
      }),
    ).resolves.toEqual({
      deps: { acme: "^1" },
      osvEcosystem: "Packagist",
      purlType: undefined,
    });
  });

  test("returns defaults when the package row is missing", async () => {
    // No package row → loadPackageVersionMetadata returns null, graph never runs.
    const { collectPackageDependencies } = await loadModule(makeDb([[]]));

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
      }),
    ).resolves.toEqual({
      deps: {},
      osvEcosystem: "npm",
    });
  });

  test("treats invalid version metadata as an empty record", async () => {
    // Package found, but the version row has non-object metadata: the safeParse
    // fallback yields {} so the graph sees an empty metadata object.
    const { collectPackageDependencies } = await loadModule(
      makeDb([[{ id: "pkg_1" }], [{ metadata: "not-an-object" }]]),
    );

    const seen: unknown[] = [];
    const scan: RegistryPlugin["scan"] = {
      defaultOsvEcosystem: "npm",
      dependencyGraph: ({ metadata }) => {
        seen.push(metadata);
        return { deps: {}, osvEcosystem: "npm" };
      },
    };

    await collectPackageDependencies({
      repositoryId: "repo_1",
      module: moduleWithScan(scan),
      artifactName: "package",
      artifactVersion: "1.0.0",
    });
    expect(seen).toEqual([{}]);
  });
});
