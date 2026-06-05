import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryPackageVersionRow,
} from "@hootifactory/registry";
import { createTestRegistryContext, createTestRouteMatch } from "@hootifactory/registry/testing";
import { ComposerAdapter } from "./composer-adapter";

function packageRow(name: string): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: name.split("/")[0] ?? null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(version: string, metadata: unknown): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: "pkg_1",
    version,
    metadata,
    sizeBytes: 10,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function assetRow(overrides: Partial<RegistryAssetRow>): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: "pkg_1",
    packageVersionId: "ver_1",
    blobRefId: "ref_1",
    digest: "sha256:aaa",
    role: "composer_dist",
    scope: "acme/widget/1.0.0.zip",
    path: "acme/widget/1.0.0.zip",
    mediaType: "application/zip",
    sizeBytes: 10,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ComposerAdapter", () => {
  test("declares root, metadata, download, and upload routes", () => {
    expect(new ComposerAdapter().routes()).toEqual([
      { method: "GET", pattern: "/packages.json", handlerId: "root" },
      { method: "GET", pattern: "/p2/:vendor/:package", handlerId: "metadata" },
      { method: "GET", pattern: "/dist/:path+", handlerId: "download" },
      { method: "PUT", pattern: "/packages/:vendor/:package", handlerId: "upload" },
    ]);
  });

  test("scopes permissions to the dist artifact or the vendor/package", () => {
    const adapter = new ComposerAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/dist/:path+", handlerId: "download" },
          { path: "acme/widget/1.0.0.zip" },
        ),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "acme/widget/1.0.0.zip" },
    });
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/p2/:vendor/:package", handlerId: "metadata" },
          { vendor: "acme", package: "widget.json" },
        ),
      ),
    ).toEqual({ action: "read", resource: { type: "package", packageName: "acme/widget" } });
    expect(
      adapter.requiredPermission(
        "PUT",
        createTestRouteMatch(
          { method: "PUT", pattern: "/packages/:vendor/:package", handlerId: "upload" },
          { vendor: "acme", package: "widget" },
        ),
      ),
    ).toEqual({ action: "write", resource: { type: "package", packageName: "acme/widget" } });
  });

  test("serves p2 metadata for a known package", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) =>
      name === "acme/widget" ? packageRow("acme/widget") : null;
    ctx.data.versions.listLive = async () => [
      versionRow("1.0.0", {
        name: "acme/widget",
        version: "1.0.0",
        type: "library",
        dist: { reference: "ref1", shasum: "sha1abc" },
        distDigest: "sha256:aaa",
      }),
    ];
    const res = await new ComposerAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/p2/:vendor/:package", handlerId: "metadata" },
        { vendor: "acme", package: "widget.json" },
      ),
      new Request("https://registry.test/p2/acme/widget.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    const doc = JSON.parse(await res.text());
    expect(doc.packages["acme/widget"][0].version).toBe("1.0.0");
    expect(doc.packages["acme/widget"][0].dist.url).toContain("/dist/acme/widget/1.0.0.zip");
  });

  test("returns 404 metadata for an unknown package", async () => {
    const ctx = createTestRegistryContext();
    const res = await new ComposerAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/p2/:vendor/:package", handlerId: "metadata" },
        { vendor: "acme", package: "nope.json" },
      ),
      new Request("https://registry.test/p2/acme/nope.json"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("downloads a dist via its path-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("composer_dist");
      expect(scope).toBe("acme/widget/1.0.0.zip");
      return assetRow({ digest: "sha256:bbb" });
    };
    ctx.data.content.blobRefExists = async () => true;
    const res = await new ComposerAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/dist/:path+", handlerId: "download" },
        { path: "acme/widget/1.0.0.zip" },
      ),
      new Request("https://registry.test/dist/acme/widget/1.0.0.zip"),
      ctx,
    );
    expect(res.status).toBe(200);
  });
});
