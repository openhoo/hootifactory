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

function downloadMatch(crate: string, version: string): RouteMatch {
  return {
    entry: {
      method: "GET",
      pattern: "/api/v1/crates/:crate/:version/download",
      handlerId: "download",
    },
    params: { crate, version },
    path: `/api/v1/crates/${crate}/${version}/download`,
  } satisfies RouteMatch;
}

const indexEntry = {
  name: "demo_crate",
  vers: "1.2.3",
  deps: [],
  cksum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  features: {},
  yanked: false,
};
const validMeta = {
  index: indexEntry,
  crateDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

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

  test("download lowercases the crate name so uppercase crates resolve (no 404)", async () => {
    // Published as `MyCrate`; index advertises original case, so cargo requests
    // /api/v1/crates/MyCrate/1.2.3/download. Publish stored the package record and
    // blob scope lowercased, so download must canonicalize to match (#219).
    const downloadMatch = {
      entry: {
        method: "GET",
        pattern: "/api/v1/crates/:crate/:version/download",
        handlerId: "download",
      },
      params: { crate: "MyCrate", version: "1.2.3" },
      path: "/api/v1/crates/MyCrate/1.2.3/download",
    } satisfies RouteMatch;

    const ctx = createTestRegistryContext();
    let lookedUpName: string | undefined;
    let blobScope: string | undefined;
    ctx.data.packages.findByName = async (name) => {
      lookedUpName = name;
      return { ...pkg, name: "mycrate" };
    };
    ctx.data.versions.findLive = async () =>
      versionRow({
        index: {
          name: "MyCrate",
          vers: "1.2.3",
          deps: [],
          cksum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          features: {},
          yanked: false,
        },
        crateDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
    ctx.data.content.blobRefExists = async (opts) => {
      blobScope = opts.scope;
      return true;
    };

    const res = await new CargoAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/api/v1/crates/MyCrate/1.2.3/download"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(lookedUpName).toBe("mycrate");
    expect(blobScope).toBe("mycrate@1.2.3.crate");
  });

  test("sparse index serializes stored index entries without strict metadata revalidation", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "cargo", mountPath: "cargo/private" };
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

  test("scopes download permissions to the artifact and other crate routes to the package", () => {
    const adapter = new CargoAdapter();
    const downloadEntry = {
      method: "GET" as const,
      pattern: "/api/v1/crates/:crate/:version/download",
      handlerId: "download",
    };
    expect(
      adapter.requiredPermission("GET", {
        entry: downloadEntry,
        params: { crate: "MyCrate", version: "1.2.3" },
        path: "/api/v1/crates/MyCrate/1.2.3/download",
      }),
    ).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "mycrate",
        artifactRef: "mycrate@1.2.3.crate",
      },
    });
    expect(
      adapter.requiredPermission("PUT", {
        entry: { method: "PUT", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersAdd" },
        params: { crate: "MyCrate" },
        path: "/api/v1/crates/MyCrate/owners",
      }),
    ).toEqual({ action: "write", resource: { type: "package", packageName: "mycrate" } });
  });

  test("serves the sparse-registry config document pointing at the mount", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, mountPath: "acme/crates" };
    const res = await new CargoAdapter().handle(
      {
        entry: { method: "GET", pattern: "/config.json", handlerId: "config" },
        params: {},
        path: "/config.json",
      },
      new Request("https://registry.test/config.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      dl: "https://registry.example.test/acme/crates/api/v1/crates",
      api: "https://registry.example.test/acme/crates",
    });
  });

  test("download 404s when the crate is unknown", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new CargoAdapter().handle(
        downloadMatch("demo_crate", "1.2.3"),
        new Request("https://registry.test/api/v1/crates/demo_crate/1.2.3/download"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("download 404s when the stored version lacks a crate digest", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => versionRow({ index: indexEntry });
    await expect(
      new CargoAdapter().handle(
        downloadMatch("demo_crate", "1.2.3"),
        new Request("https://registry.test/api/v1/crates/demo_crate/1.2.3/download"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("index 404s on a path that is not the canonical shard for the crate", async () => {
    const ctx = createTestRegistryContext();
    await expect(
      new CargoAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:path+", handlerId: "index" },
          params: { path: "xx/yy/demo_crate" },
          path: "/xx/yy/demo_crate",
        },
        new Request("https://registry.test/xx/yy/demo_crate"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("index 404s when the crate has no package record", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new CargoAdapter().handle(
        indexMatch,
        new Request("https://registry.test/de/mo/demo_crate"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("yank toggles the stored index entry's yanked flag", async () => {
    const ctx = createTestRegistryContext();
    let updated: Record<string, unknown> | undefined;
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => versionRow(validMeta);
    ctx.data.versions.updateMetadata = async (_row, metadata) => {
      updated = metadata;
    };
    const res = await new CargoAdapter().handle(
      {
        entry: {
          method: "DELETE",
          pattern: "/api/v1/crates/:crate/:version/yank",
          handlerId: "yank",
        },
        params: { crate: "demo_crate", version: "1.2.3" },
        path: "/api/v1/crates/demo_crate/1.2.3/yank",
      },
      new Request("https://registry.test/api/v1/crates/demo_crate/1.2.3/yank", {
        method: "DELETE",
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect((updated?.index as { yanked: boolean }).yanked).toBe(true);
  });

  test("unyank 404s when the version is missing", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => null;
    await expect(
      new CargoAdapter().handle(
        {
          entry: {
            method: "PUT",
            pattern: "/api/v1/crates/:crate/:version/unyank",
            handlerId: "unyank",
          },
          params: { crate: "demo_crate", version: "1.2.3" },
          path: "/api/v1/crates/demo_crate/1.2.3/unyank",
        },
        new Request("https://registry.test/api/v1/crates/demo_crate/1.2.3/unyank", {
          method: "PUT",
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("lists crate owners derived from version publishers", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo_crate");
      return pkg;
    };
    ctx.data.versions.listPublishers = async () => [
      { id: "12345678-90ab-cdef-0000-000000000000", login: "alice", name: "Alice" },
    ];
    const res = await new CargoAdapter().handle(
      {
        entry: { method: "GET", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersList" },
        params: { crate: "Demo_Crate" },
        path: "/api/v1/crates/Demo_Crate/owners",
      },
      new Request("https://registry.test/api/v1/crates/Demo_Crate/owners"),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      users: [{ id: 0x12345678, login: "alice", name: "Alice" }],
    });
  });

  test("acknowledges owner add requests without mutating real ownership", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    const res = await new CargoAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersAdd" },
        params: { crate: "demo_crate" },
        path: "/api/v1/crates/demo_crate/owners",
      },
      new Request("https://registry.test/api/v1/crates/demo_crate/owners", {
        method: "PUT",
        body: JSON.stringify({ users: ["alice", "bob"] }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      msg: expect.stringContaining("2 requested owner(s) added"),
    });
  });

  test("owners list 404s for an unknown crate", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new CargoAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/api/v1/crates/:crate/owners",
            handlerId: "ownersList",
          },
          params: { crate: "demo_crate" },
          path: "/api/v1/crates/demo_crate/owners",
        },
        new Request("https://registry.test/api/v1/crates/demo_crate/owners"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("publish route stores the crate and returns the cargo warnings envelope", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async ({ name }) => ({ ...pkg, name });
    ctx.data.content.storeBlobWithRef = async () => ({
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: 5,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });

    const encoder = new TextEncoder();
    const metaJson = encoder.encode(
      JSON.stringify({ name: "demo_crate", vers: "1.2.3", deps: [], features: {} }),
    );
    const crate = encoder.encode("crate");
    const body = new Uint8Array(4 + metaJson.length + 4 + crate.length);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, metaJson.length, true);
    body.set(metaJson, 4);
    dv.setUint32(4 + metaJson.length, crate.length, true);
    body.set(crate, 4 + metaJson.length + 4);

    const res = await new CargoAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/api/v1/crates/new", handlerId: "publish" },
        params: {},
        path: "/api/v1/crates/new",
      },
      new Request("https://registry.test/api/v1/crates/new", { method: "PUT", body }),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      warnings: { invalid_categories: [], invalid_badges: [], other: [] },
    });
  });
});
