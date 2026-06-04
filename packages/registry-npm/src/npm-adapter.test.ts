import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
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

const packumentMatch = {
  entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
  params: { pkg: "pkg" },
  path: "pkg",
} satisfies RouteMatch;

const tarballMatch = {
  entry: { method: "GET", pattern: "/:pkg+/-/:filename", handlerId: "tarball" },
  params: { pkg: "@scope/pkg", filename: "pkg-1.2.3-beta.1.tgz" },
  path: "@scope/pkg/-/pkg-1.2.3-beta.1.tgz",
} satisfies RouteMatch;

function packageRow(id: string, name: string): RegistryPackageSummaryRow {
  return { id, orgId: "org_1", repositoryId: "repo_1", name };
}

function fullPackageRow(id: string, name: string): RegistryPackageRow {
  return {
    ...packageRow(id, name),
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
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
    let searchVersionReads = 0;
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
    ctx.data.versions.listSearchVersionsForPackages = async (
      pkgs,
      preferredVersionsByPackageId,
    ) => {
      searchVersionReads += 1;
      expect(pkgs.map((pkg) => pkg.id)).toEqual(["pkg_1", "pkg_2"]);
      expect([...preferredVersionsByPackageId]).toEqual([["pkg_1", "1.0.0"]]);
      return new Map([
        ["pkg_1", versionRow("pkg_1", "1.0.0", new Date("2026-01-02T00:00:00.000Z"))],
        ["pkg_2", versionRow("pkg_2", "0.1.0", new Date("2026-01-01T00:00:00.000Z"))],
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
    expect(searchVersionReads).toBe(1);
    expect(batchedTagReads).toBe(1);
  });

  test("packument responses reuse cached bodies and etags", async () => {
    const adapter = new NpmAdapter();
    const ctx = createTestRegistryContext();
    let fullVersionReads = 0;
    let fingerprintReads = 0;

    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("pkg");
      return fullPackageRow("pkg_1", "pkg");
    };
    ctx.data.tags.listLive = async () => ({ latest: "1.0.0" });
    ctx.data.versions.listLiveFingerprints = async () => {
      fingerprintReads += 1;
      return [{ version: "1.0.0", updatedAt: new Date("2026-01-01T00:00:00.000Z") }];
    };
    ctx.data.versions.listLive = async () => {
      fullVersionReads += 1;
      return [
        {
          ...versionRow("pkg_1", "1.0.0", new Date("2026-01-01T00:00:00.000Z")),
          metadata: {
            manifest: { name: "pkg", version: "1.0.0", description: "cached" },
          },
        },
      ];
    };

    const first = await adapter.handle(
      packumentMatch,
      new Request("https://registry.test/pkg"),
      ctx,
    );
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^".+"$/);
    expect(await first.json()).toMatchObject({ description: "cached" });
    expect(fullVersionReads).toBe(1);

    const metadata = await adapter.generateMetadata("pkg", ctx);
    expect(JSON.parse(String(metadata?.body))).toMatchObject({ description: "cached" });
    expect(fullVersionReads).toBe(1);

    const cached = await adapter.handle(
      packumentMatch,
      new Request("https://registry.test/pkg", { headers: { "if-none-match": etag ?? "" } }),
      ctx,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(fullVersionReads).toBe(1);
    expect(fingerprintReads).toBe(3);
  });

  test("tarball lookup derives the version and avoids scanning live versions", async () => {
    const ctx = createTestRegistryContext();
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let lookedUpVersion = "";
    let blobScope = "";

    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("@scope/pkg");
      return fullPackageRow("pkg_1", "@scope/pkg");
    };
    ctx.data.versions.listLive = async () => {
      throw new Error("tarball lookup should not scan live versions");
    };
    ctx.data.versions.findLive = async (pkg, version) => {
      expect(pkg.id).toBe("pkg_1");
      lookedUpVersion = version;
      return {
        ...versionRow(pkg.id, version, new Date("2026-01-01T00:00:00.000Z")),
        metadata: {
          manifest: { name: "@scope/pkg", version },
          dist: {
            filename: "pkg-1.2.3-beta.1.tgz",
            blobDigest: digest,
            shasum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            integrity: "sha512-test",
            size: 12,
          },
        },
      };
    };
    ctx.data.content.blobRefExists = async (input) => {
      blobScope = input.scope;
      expect(input).toMatchObject({
        digest,
        kind: "npm_tarball",
        scope: "@scope/pkg@1.2.3-beta.1",
      });
      return true;
    };
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType, extraHeaders }) =>
      new Response(`blob:${digest}`, {
        headers: {
          ...extraHeaders,
          "content-type": contentType,
        },
      });

    const res = await new NpmAdapter().handle(
      tarballMatch,
      new Request("https://registry.test/@scope/pkg/-/pkg-1.2.3-beta.1.tgz"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
    await expect(res.text()).resolves.toBe(`blob:${digest}`);
    expect(lookedUpVersion).toBe("1.2.3-beta.1");
    expect(blobScope).toBe("@scope/pkg@1.2.3-beta.1");
  });
});
