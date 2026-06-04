import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { CargoAdapter } from "./cargo-adapter";
import {
  cargoIndexPath,
  cargoVersionIdentity,
  isValidCargoCrateName,
  isValidCargoVersion,
} from "./cargo-validation";

const indexMatch = {
  entry: { method: "GET", pattern: "/:path+", handlerId: "index" },
  params: { path: "de/mo/demo_crate" },
  path: "/de/mo/demo_crate",
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "demo_crate",
  namespace: null,
  metadata: {},
  latestVersion: "1.2.3",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function versionRow(metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: pkg.id,
    version: "1.2.3",
    metadata,
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

describe("Cargo adapter", () => {
  test("computes sparse index paths for short and long crate names", () => {
    expect(cargoIndexPath("a")).toBe("1/a");
    expect(cargoIndexPath("AB")).toBe("2/ab");
    expect(cargoIndexPath("Tok")).toBe("3/t/tok");
    expect(cargoIndexPath("serde_json")).toBe("se/rd/serde_json");
  });

  test("validates crate names before creating package records", () => {
    expect(isValidCargoCrateName("serde_json")).toBe(true);
    expect(isValidCargoCrateName("bad/name")).toBe(false);
    expect(isValidCargoCrateName("../crate")).toBe(false);
    expect(isValidCargoCrateName("bad\\name")).toBe(false);
  });

  test("validates Cargo SemVer versions including numeric prerelease identifiers", () => {
    expect(isValidCargoVersion("1.2.3")).toBe(true);
    expect(isValidCargoVersion("1.2.3-alpha.1+build.5")).toBe(true);
    expect(isValidCargoVersion("1.2.3-alpha.01")).toBe(false);
    expect(isValidCargoVersion("01.2.3")).toBe(false);
    expect(cargoVersionIdentity("1.2.3+build.5")).toBe("1.2.3");
  });

  test("declares publish, yank, owner, download, and index routes", () => {
    expect(new CargoAdapter().routes()).toEqual([
      { method: "GET", pattern: "/config.json", handlerId: "config" },
      { method: "PUT", pattern: "/api/v1/crates/new", handlerId: "publish" },
      { method: "GET", pattern: "/api/v1/crates/:crate/:version/download", handlerId: "download" },
      { method: "DELETE", pattern: "/api/v1/crates/:crate/:version/yank", handlerId: "yank" },
      { method: "PUT", pattern: "/api/v1/crates/:crate/:version/unyank", handlerId: "unyank" },
      { method: "GET", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersList" },
      { method: "PUT", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersAdd" },
      { method: "DELETE", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersRemove" },
      { method: "GET", pattern: "/:path+", handlerId: "index" },
    ]);
  });

  test("uses read permissions for reads and write permissions for mutations", () => {
    const adapter = new CargoAdapter();

    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Bearer realm="hootifactory"');
  });

  test("sparse index serializes stored index entries without strict metadata revalidation", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, format: "cargo", mountPath: "cargo/private" };
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.versions.listLive = async (row, opts) => {
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [
        versionRow({
          index: {
            name: "demo_crate",
            vers: "1.2.3",
            deps: [],
            cksum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            features: {},
            yanked: false,
            storedAtPublishTime: true,
          },
          crateDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ];
    };

    const res = await new CargoAdapter().handle(
      indexMatch,
      new Request("https://registry.test/de/mo/demo_crate"),
      ctx,
    );

    const etag = res.headers.get("etag");
    expect(res.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(JSON.parse((await res.text()).trim())).toEqual({
      name: "demo_crate",
      vers: "1.2.3",
      deps: [],
      cksum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      features: {},
      yanked: false,
      storedAtPublishTime: true,
    });

    const cached = await new CargoAdapter().handle(
      indexMatch,
      new Request("https://registry.test/de/mo/demo_crate", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });
});
