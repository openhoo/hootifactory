import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryPackageVersionRow,
} from "@hootifactory/registry";
import { createTestRegistryContext, createTestRouteMatch } from "@hootifactory/registry/testing";
import { RubygemsAdapter } from "./rubygems-adapter";

function packageRow(name: string): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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
    role: "rubygems_gem",
    scope: "hooty-1.0.0.gem",
    path: "hooty-1.0.0.gem",
    mediaType: "application/octet-stream",
    sizeBytes: 10,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("RubygemsAdapter", () => {
  test("declares the push, yank, compact-index, and download routes", () => {
    expect(new RubygemsAdapter().routes()).toEqual([
      { method: "POST", pattern: "/api/v1/gems", handlerId: "push" },
      { method: "DELETE", pattern: "/api/v1/gems/yank", handlerId: "yank" },
      { method: "GET", pattern: "/versions", handlerId: "compactVersions" },
      { method: "GET", pattern: "/names", handlerId: "compactNames" },
      { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
      { method: "GET", pattern: "/gems/:filename", handlerId: "download" },
    ]);
  });

  test("scopes permissions to the artifact or package", () => {
    const adapter = new RubygemsAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/gems/:filename", handlerId: "download" },
          { filename: "hooty-1.0.0.gem" },
        ),
      ),
    ).toEqual({ action: "read", resource: { type: "artifact", artifactRef: "hooty-1.0.0.gem" } });
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
          { gem: "hooty" },
        ),
      ),
    ).toEqual({ action: "read", resource: { type: "package", packageName: "hooty" } });
    expect(
      adapter.requiredPermission(
        "POST",
        createTestRouteMatch({ method: "POST", pattern: "/api/v1/gems", handlerId: "push" }, {}),
      ),
    ).toEqual({ action: "write" });
  });

  test("serves the compact info file for a known gem", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) => (name === "hooty" ? packageRow("hooty") : null);
    ctx.data.versions.listLive = async () => [
      versionRow("1.0.0", {
        index: { name: "hooty", version: "1.0.0", deps: [], yanked: false },
        sha256: "a".repeat(64),
      }),
    ];
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
        { gem: "hooty" },
      ),
      new Request("https://registry.test/info/hooty"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`---\n1.0.0 |checksum:${"a".repeat(64)}\n`);
  });

  test("returns 404 from compact info for an unknown gem", async () => {
    const ctx = createTestRegistryContext();
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
        { gem: "nope" },
      ),
      new Request("https://registry.test/info/nope"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("downloads a stored gem via its filename-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("rubygems_gem");
      expect(scope).toBe("hooty-1.0.0.gem");
      return assetRow({ digest: "sha256:bbb" });
    };
    ctx.data.content.blobRefExists = async () => true;
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/gems/:filename", handlerId: "download" },
        { filename: "hooty-1.0.0.gem" },
      ),
      new Request("https://registry.test/gems/hooty-1.0.0.gem"),
      ctx,
    );
    expect(res.status).toBe(200);
  });
});
