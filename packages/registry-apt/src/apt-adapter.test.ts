import { describe, expect, test } from "bun:test";
import type { RegistryAssetRow } from "@hootifactory/registry";
import { createTestRegistryContext, createTestRouteMatch } from "@hootifactory/registry/testing";
import { AptAdapter } from "./apt-adapter";

function aptAsset(): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: "pkg_1",
    packageVersionId: "ver_1",
    blobRefId: "ref_1",
    digest: "sha256:aaa",
    role: "apt_deb",
    scope: "pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb",
    path: "pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb",
    mediaType: "application/vnd.debian.binary-package",
    sizeBytes: 100,
    metadata: {
      controlText: "Package: hootpkg\nVersion: 1.0.0\nArchitecture: amd64",
      md5: "abc",
      sha256: "def",
      debSize: 100,
      package: "hootpkg",
      version: "1.0.0",
      architecture: "amd64",
      suite: "stable",
      component: "main",
    },
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function withDebAssets() {
  const ctx = createTestRegistryContext();
  ctx.data.assets.list = async (input) =>
    (input?.offset ?? 0) === 0 ? { assets: [aptAsset()], total: 1 } : { assets: [], total: 1 };
  return ctx;
}

describe("AptAdapter", () => {
  test("declares the dists, pool, and signed-release routes", () => {
    expect(new AptAdapter().routes()).toEqual([
      { method: "GET", pattern: "/dists/:suite/Release", handlerId: "release" },
      { method: "GET", pattern: "/dists/:suite/InRelease", handlerId: "inRelease" },
      { method: "GET", pattern: "/dists/:suite/Release.gpg", handlerId: "releaseSig" },
      {
        method: "GET",
        pattern: "/dists/:suite/:component/:archdir/Packages",
        handlerId: "packages",
      },
      {
        method: "GET",
        pattern: "/dists/:suite/:component/:archdir/Packages.gz",
        handlerId: "packagesGz",
      },
      { method: "GET", pattern: "/pool/:path+", handlerId: "download" },
      { method: "PUT", pattern: "/pool/:path+", handlerId: "upload" },
    ]);
  });

  test("scopes pool writes to the artifact path", () => {
    expect(
      new AptAdapter().requiredPermission(
        "PUT",
        createTestRouteMatch(
          { method: "PUT", pattern: "/pool/:path+", handlerId: "upload" },
          { path: "main/h/hootpkg/hootpkg_1.0.0_amd64.deb" },
        ),
      ),
    ).toEqual({
      action: "write",
      resource: { type: "artifact", artifactRef: "pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb" },
    });
  });

  test("serves a generated Release listing the suite's Packages", async () => {
    const res = await new AptAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/dists/:suite/Release", handlerId: "release" },
        { suite: "stable" },
      ),
      new Request("https://r.test/apt/o/r/dists/stable/Release"),
      withDebAssets(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Suite: stable");
    expect(body).toContain("main/binary-amd64/Packages");
  });

  test("serves a generated Packages index for the component/arch", async () => {
    const res = await new AptAdapter().handle(
      createTestRouteMatch(
        {
          method: "GET",
          pattern: "/dists/:suite/:component/:archdir/Packages",
          handlerId: "packages",
        },
        { suite: "stable", component: "main", archdir: "binary-amd64" },
      ),
      new Request("https://r.test/apt/o/r/dists/stable/main/binary-amd64/Packages"),
      withDebAssets(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Package: hootpkg");
  });

  test("returns 404 for InRelease (unsigned v1)", async () => {
    const res = await new AptAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/dists/:suite/InRelease", handlerId: "inRelease" },
        { suite: "stable" },
      ),
      new Request("https://r.test/apt/o/r/dists/stable/InRelease"),
      createTestRegistryContext(),
    );
    expect(res.status).toBe(404);
  });

  test("downloads a .deb via its pool-path asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("apt_deb");
      expect(scope).toBe("pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb");
      return aptAsset();
    };
    ctx.data.content.blobRefExists = async () => true;
    const res = await new AptAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/pool/:path+", handlerId: "download" },
        { path: "main/h/hootpkg/hootpkg_1.0.0_amd64.deb" },
      ),
      new Request("https://r.test/apt/o/r/pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb"),
      ctx,
    );
    expect(res.status).toBe(200);
  });
});
