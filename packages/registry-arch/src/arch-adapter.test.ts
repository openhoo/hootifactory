import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { ArchAdapter } from "./arch-adapter";
import { buildArchPackage } from "./arch-fixtures";
import type { ArchVersionMeta } from "./arch-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);
const FILENAME = "foo-1.2.3-1-x86_64.pkg.tar.zst";

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: "1.2.3-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(metadata: ArchVersionMeta): RegistryPackageVersionRow {
  return {
    id: `ver_${metadata.pkgver}`,
    orgId: "org_1",
    packageId: `pkg_${metadata.pkgname}`,
    version: metadata.pkgver,
    metadata,
    sizeBytes: metadata.csize,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const storedMeta: ArchVersionMeta = {
  blobDigest: DIGEST,
  sha256: HEX,
  filename: FILENAME,
  pkgname: "foo",
  pkgver: "1.2.3-1",
  arch: "x86_64",
  csize: 4096,
  depends: ["bar", "baz>=1.0"],
  pkgdesc: "demo package",
};

function archContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "arch", mountPath: "arch/private" };
  return ctx;
}

const dbMatch: RouteMatch = {
  entry: { method: "GET", pattern: "/:repo/os/:arch/:file", handlerId: "fetch" },
  params: { repo: "core", arch: "x86_64", file: "core.db" },
  path: "/core/os/x86_64/core.db",
};

function downloadMatch(file = FILENAME): RouteMatch {
  return {
    entry: { method: "GET", pattern: "/:repo/os/:arch/:file", handlerId: "fetch" },
    params: { repo: "core", arch: "x86_64", file },
    path: `/core/os/x86_64/${file}`,
  };
}

function rpcMatch(): RouteMatch {
  return {
    entry: { method: "GET", pattern: "/rpc/", handlerId: "rpc" },
    params: {},
    path: "/rpc/",
  };
}

describe("Arch adapter", () => {
  test("declares rpc, fetch, and publish routes (literal /rpc before catch-alls)", () => {
    expect(new ArchAdapter().routes()).toEqual([
      { method: "GET", pattern: "/rpc/", handlerId: "rpc" },
      { method: "GET", pattern: "/rpc", handlerId: "rpc" },
      { method: "GET", pattern: "/:repo/os/:arch/:file", handlerId: "fetch" },
      { method: "PUT", pattern: "/:repo/os/:arch/:file", handlerId: "publish" },
    ]);
  });

  test("reads use read permission, publish uses write, with basic auth", () => {
    const adapter = new ArchAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("package download permission targets the artifact ref", () => {
    const adapter = new ArchAdapter();
    expect(adapter.requiredPermission("GET", downloadMatch())).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: FILENAME },
    });
  });

  test("db request permission stays a plain read (no artifact ref)", () => {
    const adapter = new ArchAdapter();
    expect(adapter.requiredPermission("GET", dbMatch)).toEqual({ action: "read" });
  });

  test("capabilities advertise proxyable + virtualizable", () => {
    const caps = new ArchAdapter().capabilities;
    expect(caps.proxyable).toBe(true);
    expect(caps.virtualizable).toBe(true);
    expect(caps.contentAddressable).toBe(false);
    expect(caps.resumableUploads).toBe(false);
  });

  test("GET <repo>.db builds the sync DB from live versions, cacheable", async () => {
    const ctx = archContext();
    ctx.data.packages.list = async () => [
      { id: "pkg_foo", orgId: "org_1", repositoryId: "repo_1", name: "foo" },
    ];
    ctx.data.versions.listLiveForPackages = async (pkgs) => {
      expect(pkgs).toHaveLength(1);
      return new Map([["pkg_foo", [versionRow(storedMeta)]]]);
    };

    const res = await new ArchAdapter().handle(
      dbMatch,
      new Request("https://registry.test/core/os/x86_64/core.db"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const gz = new Uint8Array(await res.arrayBuffer());
    const tar = new TextDecoder().decode(gunzipSync(gz));
    expect(tar).toContain("foo-1.2.3-1/desc");
    expect(tar).toContain("%FILENAME%");
    expect(tar).toContain(FILENAME);

    if (!etag) throw new Error("expected etag");
    const cached = await new ArchAdapter().handle(
      dbMatch,
      new Request("https://registry.test/core/os/x86_64/core.db", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET <repo>.db.tar.gz serves the same DB as <repo>.db", async () => {
    const ctx = archContext();
    ctx.data.packages.list = async () => [
      { id: "pkg_foo", orgId: "org_1", repositoryId: "repo_1", name: "foo" },
    ];
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([["pkg_foo", [versionRow(storedMeta)]]]);

    const match: RouteMatch = {
      entry: { method: "GET", pattern: "/:repo/os/:arch/:file", handlerId: "fetch" },
      params: { repo: "core", arch: "x86_64", file: "core.db.tar.gz" },
      path: "/core/os/x86_64/core.db.tar.gz",
    };
    const res = await new ArchAdapter().handle(
      match,
      new Request("https://registry.test/core/os/x86_64/core.db.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
  });

  test("package download resolves the stored blob by filename scope", async () => {
    const ctx = archContext();
    const served: { digest?: string } = {};
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("arch_package");
      expect(scope).toBe(FILENAME);
      return {
        id: "asset_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        packageId: "pkg_foo",
        packageVersionId: "ver_1",
        blobRefId: "ref_1",
        digest: DIGEST,
        role: "arch_package",
        scope: FILENAME,
        path: FILENAME,
        mediaType: "application/octet-stream",
        sizeBytes: 4096,
        metadata: {},
        deletedAt: null,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      };
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("pkg-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new ArchAdapter().handle(
      downloadMatch(),
      new Request(`https://registry.test/core/os/x86_64/${FILENAME}`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("pkg-bytes");
  });

  test("package download 404s when the asset is unknown", async () => {
    const ctx = archContext();
    ctx.data.assets.findByScope = async () => null;
    await expect(
      new ArchAdapter().handle(
        downloadMatch(),
        new Request(`https://registry.test/core/os/x86_64/${FILENAME}`),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("fetch with an unrecognized filename throws notFound", async () => {
    const ctx = archContext();
    await expect(
      new ArchAdapter().handle(
        downloadMatch("not-a-package.txt"),
        new Request("https://registry.test/core/os/x86_64/not-a-package.txt"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("fetch with an invalid repository name throws NAME_INVALID", async () => {
    const ctx = archContext();
    await expect(
      new ArchAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:repo/os/:arch/:file", handlerId: "fetch" },
          params: { repo: "bad repo", arch: "x86_64", file: "core.db" },
          path: "/bad%20repo/os/x86_64/core.db",
        },
        new Request("https://registry.test/bad%20repo/os/x86_64/core.db"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("PUT publishes a package and stores .PKGINFO-derived metadata", async () => {
    const ctx = archContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown; asset?: unknown } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async (_pkg, version) => {
      expect(version).toBe("1.2.3-1");
      return false;
    };
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4096,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      committed.asset = input.asset;
      return { versionId: "ver_1" };
    };

    const pkg = buildArchPackage({
      pkgname: "foo",
      pkgver: "1.2.3-1",
      arch: "x86_64",
      pkgdesc: "demo package",
      depends: ["bar", "baz>=1.0"],
    });

    const res = await new ArchAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:repo/os/:arch/:file", handlerId: "publish" },
        params: { repo: "core", arch: "x86_64", file: FILENAME },
        path: `/core/os/x86_64/${FILENAME}`,
      },
      new Request(`https://registry.test/core/os/x86_64/${FILENAME}`, {
        method: "PUT",
        body: pkg,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      pkgname: "foo",
      pkgver: "1.2.3-1",
      filename: FILENAME,
    });
    expect(committed.scan).toEqual({
      name: "foo",
      version: "1.2.3-1",
      mediaType: "application/octet-stream",
    });
    // blobDigest/sha256 are computed from the real package bytes at parse time,
    // not the mocked store result, so assert their shape rather than a fixed value.
    expect(committed.metadata).toMatchObject({
      pkgname: "foo",
      pkgver: "1.2.3-1",
      arch: "x86_64",
      pkgdesc: "demo package",
      depends: ["bar", "baz>=1.0"],
      filename: FILENAME,
    });
    expect(committed.metadata?.blobDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(committed.metadata?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(committed.metadata?.csize).toBe(pkg.length);
    expect(committed.asset).toMatchObject({
      role: "arch_package",
      scope: FILENAME,
      path: FILENAME,
    });
  });

  test("PUT returns 409 when the version already exists", async () => {
    const ctx = archContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const pkg = buildArchPackage({ pkgname: "foo", pkgver: "1.2.3-1", arch: "x86_64" });
    const res = await new ArchAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:repo/os/:arch/:file", handlerId: "publish" },
        params: { repo: "core", arch: "x86_64", file: FILENAME },
        path: `/core/os/x86_64/${FILENAME}`,
      },
      new Request(`https://registry.test/core/os/x86_64/${FILENAME}`, { method: "PUT", body: pkg }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "package version already exists" });
  });

  test("PUT rejects a package whose .PKGINFO disagrees with the route filename", async () => {
    const ctx = archContext();
    // The archive declares pkgname "evil", but the upload path names "foo".
    const pkg = buildArchPackage({ pkgname: "evil", pkgver: "1.2.3-1", arch: "x86_64" });
    const res = await new ArchAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:repo/os/:arch/:file", handlerId: "publish" },
        params: { repo: "core", arch: "x86_64", file: FILENAME },
        path: `/core/os/x86_64/${FILENAME}`,
      },
      new Request(`https://registry.test/core/os/x86_64/${FILENAME}`, { method: "PUT", body: pkg }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "package metadata does not match filename" });
  });

  test("PUT of an empty body is rejected with 400", async () => {
    const ctx = archContext();
    const res = await new ArchAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:repo/os/:arch/:file", handlerId: "publish" },
        params: { repo: "core", arch: "x86_64", file: FILENAME },
        path: `/core/os/x86_64/${FILENAME}`,
      },
      new Request(`https://registry.test/core/os/x86_64/${FILENAME}`, {
        method: "PUT",
        body: new Uint8Array(),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("GET /rpc/?type=info returns the AUR result shape for known packages", async () => {
    const ctx = archContext();
    ctx.data.packages.findByName = async (name) => (name === "foo" ? pkgRow("foo") : null);
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow(storedMeta)];
    };

    const res = await new ArchAdapter().handle(
      rpcMatch(),
      new Request("https://registry.test/rpc/?v=5&type=info&arg[]=foo&arg[]=missing"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      type: string;
      resultcount: number;
      results: Array<{ Name: string; Version: string; Depends?: string[] }>;
    };
    expect(body.version).toBe(5);
    expect(body.type).toBe("info");
    expect(body.resultcount).toBe(1);
    expect(body.results[0]).toMatchObject({
      Name: "foo",
      Version: "1.2.3-1",
      Description: "demo package",
      Depends: ["bar", "baz>=1.0"],
    });
  });

  test("GET /rpc/ with an unsupported type returns an empty result set", async () => {
    const ctx = archContext();
    const res = await new ArchAdapter().handle(
      rpcMatch(),
      new Request("https://registry.test/rpc/?v=5&type=search&arg=foo"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 5, type: "search", resultcount: 0, results: [] });
  });

  test("scan.referencedDigests surfaces the stored blob digest", () => {
    const scan = new ArchAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ pkgname: "x" })).toEqual([]);
  });

  test("scan.dependencyGraph strips version constraints from depends", () => {
    const scan = new ArchAdapter().scan;
    const graph = scan?.dependencyGraph?.({ metadata: { ...storedMeta } });
    expect(graph?.purlType).toBe("alpm");
    expect(graph?.deps).toEqual({ bar: "", baz: "" });
  });
});
