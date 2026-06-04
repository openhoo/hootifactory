import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageSummaryRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { NpmAdapter } from "./npm-adapter";

const whoamiMatch = {
  entry: { method: "GET", pattern: "/-/whoami", handlerId: "whoami" },
  params: {},
  path: "/-/whoami",
} satisfies RouteMatch;

const searchMatch = {
  entry: { method: "GET", pattern: "/-/v1/search", handlerId: "search" },
  params: {},
  path: "/-/v1/search",
} satisfies RouteMatch;

function packageRow(id: string, name: string): RegistryPackageSummaryRow {
  return { id, orgId: "org_1", repositoryId: "repo_1", name };
}

function versionRow(
  packageId: string,
  version: string,
  createdAt: Date,
): RegistryPackageVersionRow {
  return {
    id: `${packageId}_${version}`,
    orgId: "org_1",
    packageId,
    version,
    metadata: { manifest: { description: `${packageId} ${version}` } },
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("npm adapter contract", () => {
  test("whoami reports the token owner when token metadata is available", async () => {
    const res = await new NpmAdapter().handle(
      whoamiMatch,
      new Request("https://registry.test/-/whoami"),
      {
        principal: {
          kind: "token",
          tokenId: "tok_123",
          tokenName: "ci-token",
          orgId: "org_123",
          ownerUserId: "user_123",
          ownerUsername: "alice",
          scopes: [],
          role: null,
          isRobot: false,
        },
      } as unknown as Parameters<NpmAdapter["handle"]>[2],
    );

    expect(await res.json()).toEqual({ username: "alice" });
  });

  test("whoami falls back to a stable token identity for unowned tokens", async () => {
    const res = await new NpmAdapter().handle(
      whoamiMatch,
      new Request("https://registry.test/-/whoami"),
      {
        principal: {
          kind: "token",
          tokenId: "tok_123",
          tokenName: "automation",
          orgId: "org_123",
          ownerUserId: null,
          ownerUsername: null,
          scopes: [],
          role: "developer",
          isRobot: true,
        },
      } as unknown as Parameters<NpmAdapter["handle"]>[2],
    );

    expect(await res.json()).toEqual({ username: "automation" });
  });

  test("search batches version and dist-tag lookups", async () => {
    const packages = [packageRow("pkg_1", "alpha"), packageRow("pkg_2", "beta")];
    let perPackageVersionReads = 0;
    let perPackageTagReads = 0;
    let batchedVersionReads = 0;
    let batchedTagReads = 0;
    const ctx = createTestRegistryContext();
    ctx.data.packages.search = async (input) => {
      expect(input).toEqual({ text: "", from: 0, size: 2 });
      return { packages, total: packages.length };
    };
    ctx.data.versions.listLive = async () => {
      perPackageVersionReads += 1;
      return [];
    };
    ctx.data.tags.listLive = async () => {
      perPackageTagReads += 1;
      return {};
    };
    ctx.data.versions.listLiveForPackages = async (pkgs, opts) => {
      batchedVersionReads += 1;
      expect(pkgs.map((pkg) => pkg.id)).toEqual(["pkg_1", "pkg_2"]);
      expect(opts).toEqual({ orderByCreated: "desc" });
      return new Map([
        [
          "pkg_1",
          [
            versionRow("pkg_1", "2.0.0", new Date("2026-01-03T00:00:00.000Z")),
            versionRow("pkg_1", "1.0.0", new Date("2026-01-02T00:00:00.000Z")),
          ],
        ],
        ["pkg_2", [versionRow("pkg_2", "0.1.0", new Date("2026-01-01T00:00:00.000Z"))]],
      ]);
    };
    ctx.data.tags.listLiveForPackages = async (pkgs) => {
      batchedTagReads += 1;
      expect(pkgs.map((pkg) => pkg.id)).toEqual(["pkg_1", "pkg_2"]);
      return new Map<string, Record<string, string>>([
        ["pkg_1", { latest: "1.0.0" }],
        ["pkg_2", {}],
      ]);
    };

    const res = await new NpmAdapter().handle(
      searchMatch,
      new Request("https://registry.test/-/v1/search?size=2"),
      ctx,
    );
    const body = (await res.json()) as {
      objects: Array<{ package: { name: string; version: string } }>;
    };

    expect(body.objects.map((object) => [object.package.name, object.package.version])).toEqual([
      ["alpha", "1.0.0"],
      ["beta", "0.1.0"],
    ]);
    expect(perPackageVersionReads).toBe(0);
    expect(perPackageTagReads).toBe(0);
    expect(batchedVersionReads).toBe(1);
    expect(batchedTagReads).toBe(1);
  });
});
