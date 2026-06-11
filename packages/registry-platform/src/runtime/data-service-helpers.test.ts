import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  assertManifestInRepo,
  assertPackageInRepo,
  assertVersionForPackage,
  assetForWrite,
  packageId,
} from "./data-service-helpers";

const ctx = () => createTestRegistryContext();

function pkgHandle() {
  const c = ctx();
  return { id: "pkg_1", orgId: c.repo.orgId, repositoryId: c.repo.id };
}

describe("repo-ownership assertions", () => {
  test("assertPackageInRepo accepts a matching package and rejects a cross-repo one", () => {
    const c = ctx();
    expect(() => assertPackageInRepo(c, pkgHandle() as any)).not.toThrow();
    expect(() =>
      assertPackageInRepo(c, { id: "p", orgId: "other", repositoryId: c.repo.id } as any),
    ).toThrow("does not belong to this repository");
    expect(() =>
      assertPackageInRepo(c, { id: "p", orgId: c.repo.orgId, repositoryId: "other" } as any),
    ).toThrow();
  });

  test("packageId returns the id only after the ownership check passes", () => {
    const c = ctx();
    expect(packageId(c, pkgHandle() as any)).toBe("pkg_1");
  });

  test("assertVersionForPackage rejects a version from another package", () => {
    expect(() =>
      assertVersionForPackage(
        { id: "pkg_1" } as any,
        { id: "v1", packageId: "pkg_2", version: "1.0.0" } as any,
      ),
    ).toThrow("does not belong to the package");
    expect(() =>
      assertVersionForPackage(
        { id: "pkg_1" } as any,
        { id: "v1", packageId: "pkg_1", version: "1.0.0" } as any,
      ),
    ).not.toThrow();
  });

  test("assertManifestInRepo enforces the repository binding", () => {
    const c = ctx();
    expect(() =>
      assertManifestInRepo(c, { id: "m1", repositoryId: c.repo.id } as any),
    ).not.toThrow();
    expect(() => assertManifestInRepo(c, { id: "m1", repositoryId: "other" } as any)).toThrow();
  });
});

describe("assetForWrite", () => {
  test("validates an embedded package handle and returns the input unchanged", () => {
    const c = ctx();
    const input = { role: "r", scope: "s", package: pkgHandle() };
    expect(assetForWrite(c, input as any)).toBe(input as any);
  });

  test("requires a package handle when a version handle is provided", () => {
    const c = ctx();
    expect(() =>
      assetForWrite(c, {
        role: "r",
        scope: "s",
        packageVersion: { id: "v1", packageId: "pkg_1", version: "1.0.0" } as any,
      } as any),
    ).toThrow("requires a package handle");
  });

  test("checks that the version belongs to the package when both are present", () => {
    const c = ctx();
    expect(() =>
      assetForWrite(c, {
        role: "r",
        scope: "s",
        package: pkgHandle() as any,
        packageVersion: { id: "v1", packageId: "other", version: "1.0.0" } as any,
      } as any),
    ).toThrow("does not belong to the package");
  });
});

describe("deleteReplacedAssetRef", () => {
  afterEach(() => mock.restore());

  test("deletes the prior asset ref when a digest was actually replaced", async () => {
    let deleteArgs: unknown[] | undefined;
    await mock.module("../assets", () => ({
      deleteRegistryAssetRef: (...args: unknown[]) => {
        deleteArgs = args;
      },
    }));
    const { deleteReplacedAssetRef } = await import("./data-service-helpers");
    const c = ctx();
    await deleteReplacedAssetRef(c, {
      previousDigest: "sha256:old",
      currentDigest: "sha256:new",
      kind: "npm_tarball",
      scope: "demo@1.0.0",
    });
    expect(deleteArgs?.[1]).toMatchObject({ digest: "sha256:old", role: "npm_tarball" });
  });

  test("does nothing when there is no replaced digest", async () => {
    let called = false;
    await mock.module("../assets", () => ({
      deleteRegistryAssetRef: () => {
        called = true;
      },
    }));
    const { deleteReplacedAssetRef } = await import("./data-service-helpers");
    await deleteReplacedAssetRef(ctx(), {
      currentDigest: "sha256:new",
      kind: "npm_tarball",
      scope: "demo@1.0.0",
    });
    expect(called).toBe(false);
  });
});
