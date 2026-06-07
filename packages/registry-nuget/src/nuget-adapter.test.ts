import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionFingerprintRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext, createTestResolvedRepo } from "@hootifactory/registry/testing";
import { NugetAdapter } from "./nuget-adapter";

const registrationMatch = {
  entry: {
    method: "GET",
    pattern: "/v3/registrations/:id/index.json",
    handlerId: "registration",
  },
  params: { id: "Hoot.Lib" },
  path: "/v3/registrations/hoot.lib/index.json",
} satisfies RouteMatch;

const searchMatch = {
  entry: { method: "GET", pattern: "/v3/query", handlerId: "search" },
  params: {},
  path: "/v3/query",
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "hoot.lib",
  namespace: null,
  metadata: {},
  latestVersion: "1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function versionRow(
  version: string,
  updatedAt: Date,
  opts: { listed?: boolean; pkg?: RegistryPackageRow } = {},
): RegistryPackageVersionRow {
  const rowPkg = opts.pkg ?? pkg;
  return {
    id: `version_${version}`,
    orgId: "org_1",
    packageId: rowPkg.id,
    version,
    metadata: {
      nupkgDigest: `sha256:${"a".repeat(64)}`,
      file: `${rowPkg.name}.${version}.nupkg`,
      displayId: rowPkg.name === "hoot.lib" ? "Hoot.Lib" : rowPkg.name,
      ...(opts.listed === undefined ? {} : { listed: opts.listed }),
    },
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt,
  };
}

function fingerprintRows(
  rows: RegistryPackageVersionRow[],
): RegistryPackageVersionFingerprintRow[] {
  return rows.map((row) => ({ version: row.version, updatedAt: row.updatedAt }));
}

describe("NuGet adapter registration cache", () => {
  test("serves unchanged registration indexes from cached body and ETag", async () => {
    const adapter = new NugetAdapter();
    let versions = [versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"))];
    let versionLoads = 0;
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLiveFingerprints = async () => fingerprintRows(versions);
    ctx.data.versions.listLive = async () => {
      versionLoads += 1;
      return versions;
    };

    const first = await adapter.handle(
      registrationMatch,
      new Request("https://registry.test/v3/registrations/hoot.lib/index.json"),
      ctx,
    );
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]{40}"$/);
    expect(versionLoads).toBe(1);

    const cached = await adapter.handle(
      registrationMatch,
      new Request("https://registry.test/v3/registrations/hoot.lib/index.json", {
        headers: { "if-none-match": etag ?? "" },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(await cached.text()).toBe("");
    expect(versionLoads).toBe(1);

    versions = [versionRow("1.0.0", new Date("2026-01-02T00:00:00.000Z"), { listed: false })];
    const rebuilt = await adapter.handle(
      registrationMatch,
      new Request("https://registry.test/v3/registrations/hoot.lib/index.json", {
        headers: { "if-none-match": etag ?? "" },
      }),
      ctx,
    );
    expect(rebuilt.status).toBe(200);
    expect(versionLoads).toBe(2);
    expect(rebuilt.headers.get("etag")).not.toBe(etag);
    expect(await rebuilt.json()).toMatchObject({
      items: [{ items: [{ catalogEntry: { version: "1.0.0", listed: false } }] }],
    });
  });
});

describe("NuGet adapter service index", () => {
  test("advertises the v3 resources rooted at the repo mount", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    const res = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/v3/index.json", handlerId: "serviceIndex" },
        params: {},
        path: "/v3/index.json",
      } satisfies RouteMatch,
      new Request("https://registry.test/v3/index.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      resources: { "@id": string; "@type": string }[];
    };
    expect(body.version).toBe("3.0.0");
    const base = `${ctx.baseUrl}/nuget/private`;
    expect(body.resources).toContainEqual({
      "@id": `${base}/v3/package`,
      "@type": "PackagePublish/2.0.0",
    });
    expect(body.resources).toContainEqual({
      "@id": `${base}/v3-flatcontainer/`,
      "@type": "PackageBaseAddress/3.0.0",
    });
  });
});

describe("NuGet adapter flat-container versions", () => {
  const versionsMatch = {
    entry: { method: "GET", pattern: "/v3-flatcontainer/:id/index.json", handlerId: "versions" },
    params: { id: "Hoot.Lib" },
    path: "/v3-flatcontainer/hoot.lib/index.json",
  } satisfies RouteMatch;

  test("returns SemVer-sorted version names", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLiveNames = async () => [
      { version: "1.10.0" },
      { version: "1.2.0" },
      { version: "1.0.0" },
    ];
    const res = await adapter.handle(
      versionsMatch,
      new Request("https://registry.test/v3-flatcontainer/hoot.lib/index.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: ["1.0.0", "1.2.0", "1.10.0"] });
  });

  test("returns 404 for an unknown package", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => null;
    const res = await adapter.handle(
      versionsMatch,
      new Request("https://registry.test/v3-flatcontainer/hoot.lib/index.json"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("returns 404 when a known package has no live versions", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLiveNames = async () => [];
    const res = await adapter.handle(
      versionsMatch,
      new Request("https://registry.test/v3-flatcontainer/hoot.lib/index.json"),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("NuGet adapter registration leaf", () => {
  function leafMatch(file: string): RouteMatch {
    return {
      entry: {
        method: "GET",
        pattern: "/v3/registrations/:id/:file",
        handlerId: "registrationLeaf",
      },
      params: { id: "Hoot.Lib", file },
      path: `/v3/registrations/hoot.lib/${file}`,
    };
  }

  test("renders a single-version catalog entry", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"));
    const res = await adapter.handle(
      leafMatch("1.0.0.json"),
      new Request("https://registry.test/v3/registrations/hoot.lib/1.0.0.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      catalogEntry: { id: "Hoot.Lib", version: "1.0.0" },
    });
  });

  test("rejects a non-json leaf file", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    await expect(
      adapter.handle(
        leafMatch("1.0.0.txt"),
        new Request("https://registry.test/v3/registrations/hoot.lib/1.0.0.txt"),
        ctx,
      ),
    ).rejects.toThrow();
  });

  test("rejects a leaf whose version is not live", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => null;
    await expect(
      adapter.handle(
        leafMatch("9.9.9.json"),
        new Request("https://registry.test/v3/registrations/hoot.lib/9.9.9.json"),
        ctx,
      ),
    ).rejects.toThrow();
  });

  test("returns 404 for an unknown package", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => null;
    const res = await adapter.handle(
      leafMatch("1.0.0.json"),
      new Request("https://registry.test/v3/registrations/hoot.lib/1.0.0.json"),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("NuGet adapter download", () => {
  function downloadMatch(file: string): RouteMatch {
    return {
      entry: {
        method: "GET",
        pattern: "/v3-flatcontainer/:id/:version/:file",
        handlerId: "download",
      },
      params: { id: "Hoot.Lib", version: "1.0.0", file },
      path: `/v3-flatcontainer/hoot.lib/1.0.0/${file}`,
    };
  }

  test("serves the stored nupkg blob", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"));
    ctx.data.content.blobRefExists = async () => true;
    const res = await adapter.handle(
      downloadMatch("hoot.lib.1.0.0.nupkg"),
      new Request("https://registry.test/v3-flatcontainer/hoot.lib/1.0.0/hoot.lib.1.0.0.nupkg"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`blob:sha256:${"a".repeat(64)}`);
  });

  test("renders a generated nuspec without touching blob storage", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"));
    const res = await adapter.handle(
      downloadMatch("hoot.lib.1.0.0.nuspec"),
      new Request("https://registry.test/v3-flatcontainer/hoot.lib/1.0.0/hoot.lib.1.0.0.nuspec"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await res.text()).toContain("<id>Hoot.Lib</id>");
  });

  test("rejects a filename that does not match the canonical id.version", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    await expect(
      adapter.handle(
        downloadMatch("wrong.1.0.0.nupkg"),
        new Request("https://registry.test/v3-flatcontainer/hoot.lib/1.0.0/wrong.1.0.0.nupkg"),
        ctx,
      ),
    ).rejects.toThrow();
  });

  test("rejects a version with no stored digest", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => null;
    await expect(
      adapter.handle(
        downloadMatch("hoot.lib.1.0.0.nupkg"),
        new Request("https://registry.test/v3-flatcontainer/hoot.lib/1.0.0/hoot.lib.1.0.0.nupkg"),
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("NuGet adapter listing toggles", () => {
  function listedMatch(method: "DELETE" | "POST"): RouteMatch {
    return {
      entry: {
        method,
        pattern: `/v3/package/:id/:version`,
        handlerId: method === "DELETE" ? "delete" : "relist",
      },
      params: { id: "Hoot.Lib", version: "1.0.0" },
      path: "/v3/package/hoot.lib/1.0.0",
    };
  }

  test("unlists a version with 204 and persists listed=false", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"));
    let updated: Record<string, unknown> | undefined;
    ctx.data.versions.updateMetadata = async (_row, metadata) => {
      updated = metadata;
    };
    const res = await adapter.handle(
      listedMatch("DELETE"),
      new Request("https://registry.test/v3/package/hoot.lib/1.0.0", { method: "DELETE" }),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(updated?.listed).toBe(false);
  });

  test("relists a version with 200 and persists listed=true", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"), { listed: false });
    let updated: Record<string, unknown> | undefined;
    ctx.data.versions.updateMetadata = async (_row, metadata) => {
      updated = metadata;
    };
    const res = await adapter.handle(
      listedMatch("POST"),
      new Request("https://registry.test/v3/package/hoot.lib/1.0.0", { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(updated?.listed).toBe(true);
  });

  test("rejects toggling a missing package", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    ctx.data.packages.findByName = async () => null;
    await expect(
      adapter.handle(
        listedMatch("DELETE"),
        new Request("https://registry.test/v3/package/hoot.lib/1.0.0", { method: "DELETE" }),
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("NuGet adapter scan provider", () => {
  test("flattens dependency groups into an OSV-ready graph", () => {
    const adapter = new NugetAdapter();
    expect(
      adapter.scan?.dependencyGraph?.({
        metadata: {
          nupkgDigest: `sha256:${"a".repeat(64)}`,
          file: "hoot.lib.1.0.0.nupkg",
          dependencyGroups: [
            {
              targetFramework: "net8.0",
              dependencies: [
                { id: "Dep.A", range: "[1.0.0, )" },
                { id: "Dep.B", range: "2.0.0" },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({ deps: { "Dep.A": "[1.0.0, )", "Dep.B": "2.0.0" } });
  });

  test("returns an empty graph for metadata without dependency groups", () => {
    const adapter = new NugetAdapter();
    expect(adapter.scan?.dependencyGraph?.({ metadata: { file: "x.1.0.0.nupkg" } })).toMatchObject({
      deps: {},
    });
  });
});

describe("NuGet adapter publish route", () => {
  test("dispatches PUT /v3/package through the publish handler", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    const res = await adapter.handle(
      {
        entry: { method: "PUT", pattern: "/v3/package", handlerId: "publish" },
        params: {},
        path: "/v3/package",
      } satisfies RouteMatch,
      new Request("https://registry.test/v3/package", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
      ctx,
    );
    // Unreadable nuspec => the publish lifecycle surfaces a 400 before storage work.
    expect(res.status).toBe(400);
  });
});

describe("NuGet adapter virtual search", () => {
  test("merges and rewrites member search bodies through the repo mount", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "virtual" };
    const response = await adapter.virtualSearch?.({
      req: new Request("https://registry.test/v3/query?q=hoot&skip=0&take=20"),
      ctx,
      collectMemberResponses: async () => [
        {
          member: createTestResolvedRepo({ mountPath: "hosted" }),
          response: Response.json({
            totalHits: 1,
            data: [{ id: "Hoot.Lib", registration: "/hosted/registrations/hoot.lib/index.json" }],
          }),
        },
        {
          member: createTestResolvedRepo({ mountPath: "hosted2" }),
          response: new Response("boom", { status: 500 }),
        },
      ],
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      totalHits: 1,
      data: [{ id: "Hoot.Lib", registration: "/virtual/registrations/hoot.lib/index.json" }],
    });
  });
});

describe("NuGet adapter search", () => {
  test("uses paged package search and batched version reads", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "nuget", mountPath: "nuget/private" };
    let packageSearches = 0;
    let batchedVersionReads = 0;
    ctx.data.packages.list = async () => {
      throw new Error("NuGet search should not load the whole package table");
    };
    ctx.data.packages.search = async (input) => {
      packageSearches += 1;
      expect(input).toEqual({ text: "hoot", from: 0, size: 250 });
      return { packages: [pkg], total: 1 };
    };
    ctx.data.versions.listLive = async () => {
      throw new Error("NuGet search should not read versions one package at a time");
    };
    ctx.data.versions.listLiveForPackages = async (packages) => {
      batchedVersionReads += 1;
      expect(packages.map((row) => row.id)).toEqual([pkg.id]);
      return new Map([[pkg.id, [versionRow("1.0.0", new Date("2026-01-01T00:00:00.000Z"))]]]);
    };

    const res = await adapter.handle(
      searchMatch,
      new Request("https://registry.test/v3/query?q=hoot"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      totalHits: 1,
      data: [{ id: "Hoot.Lib", version: "1.0.0" }],
    });
    expect(packageSearches).toBe(1);
    expect(batchedVersionReads).toBe(1);
  });
});
