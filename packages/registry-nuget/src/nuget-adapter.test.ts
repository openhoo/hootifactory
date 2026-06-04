import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionFingerprintRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
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
    ctx.repo = { ...ctx.repo, format: "nuget", mountPath: "nuget/private" };
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

describe("NuGet adapter search", () => {
  test("uses paged package search and batched version reads", async () => {
    const adapter = new NugetAdapter();
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, format: "nuget", mountPath: "nuget/private" };
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
