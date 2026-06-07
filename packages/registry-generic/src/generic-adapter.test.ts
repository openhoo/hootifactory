import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { GenericAdapter } from "./generic-adapter";
import { buildGenericVersionMeta, GENERIC_VERSION } from "./generic-validation";

const DATA = new Uint8Array([1, 2, 3, 4]);
// sha256 of the bytes [1,2,3,4].
const SHA256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const DIGEST = `sha256:${SHA256}`;

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: GENERIC_VERSION,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: "ver_current",
    orgId: "org_1",
    packageId: "pkg_demo",
    version: GENERIC_VERSION,
    metadata,
    sizeBytes: 4,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function sha512hex(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha512");
  h.update(data);
  return h.digest("hex");
}

function md5hex(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("md5");
  h.update(data);
  return h.digest("hex");
}

const SHA512_REAL = sha512hex(DATA);
const MD5_REAL = md5hex(DATA);

function metaFor(path: string, contentType = "application/octet-stream") {
  return buildGenericVersionMeta({
    path,
    blobDigest: DIGEST,
    md5: MD5_REAL,
    sha256: SHA256,
    sha512: SHA512_REAL,
    size: DATA.length,
    contentType,
  });
}

function genericContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "generic", mountPath: "generic/private" };
  return ctx;
}

function requireProxyIngest(adapter: GenericAdapter): NonNullable<GenericAdapter["proxyIngest"]> {
  if (!adapter.proxyIngest) throw new Error("expected Generic adapter to expose proxyIngest");
  return adapter.proxyIngest;
}

interface IndexBody {
  prefix: string;
  entries: { path: string; size: number; md5?: string; sha256: string; contentType: string }[];
}

async function readIndex(res: Response): Promise<IndexBody> {
  return (await res.json()) as IndexBody;
}

describe("Generic adapter", () => {
  test("declares index, download, head, publish, and delete routes (index before :path+)", () => {
    expect(new GenericAdapter().routes()).toEqual([
      { method: "GET", pattern: "/", handlerId: "index" },
      // The download route opts into proxy pull-through: a read miss against a
      // proxy repo mirrors `params.path` from upstream via proxyIngest.
      {
        method: "GET",
        pattern: "/:path+",
        handlerId: "download",
        proxyRefreshTrigger: true,
        packageParam: "path",
      },
      { method: "HEAD", pattern: "/:path+", handlerId: "head" },
      { method: "PUT", pattern: "/:path+", handlerId: "publish" },
      { method: "DELETE", pattern: "/:path+", handlerId: "remove" },
    ]);
  });

  test("advertises proxyable + virtualizable, not content-addressable, no resumable uploads", () => {
    expect(new GenericAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
  });

  test("uses read permissions for GET/HEAD, write for PUT/DELETE, and basic auth", () => {
    const adapter = new GenericAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("HEAD")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.requiredPermission("DELETE")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("permission targets the artifact ref for a path", () => {
    const adapter = new GenericAdapter();
    const match = {
      entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
      params: { path: "releases/1.0/app.tar.gz" },
      path: "/releases/1.0/app.tar.gz",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "releases/1.0/app.tar.gz",
        artifactRef: "generic/releases/1.0/app.tar.gz",
      },
    });
  });

  test("scan.referencedDigests surfaces the stored blob digest", () => {
    const scan = new GenericAdapter().scan;
    expect(scan?.referencedDigests?.({ ...metaFor("a/b.txt") })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ path: "a/b.txt" })).toEqual([]);
  });

  test("GET / lists stored paths as JSON, ordered + cacheable", async () => {
    const ctx = genericContext();
    ctx.data.packages.list = async () => [
      { id: "pkg_z", orgId: "org_1", repositoryId: "repo_1", name: "z/last.bin" },
      { id: "pkg_a", orgId: "org_1", repositoryId: "repo_1", name: "a/first.bin" },
    ];
    ctx.data.versions.listLiveForPackages = async (pkgs) =>
      new Map(pkgs.map((p) => [p.id, [versionRow(metaFor(p.name))]]));

    const res = await new GenericAdapter().handle(
      { entry: { method: "GET", pattern: "/", handlerId: "index" }, params: {}, path: "/" },
      new Request("https://registry.test/"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = await readIndex(res);
    expect(body.prefix).toBe("");
    expect(body.entries.map((e) => e.path)).toEqual(["a/first.bin", "z/last.bin"]);
    expect(body.entries[0]).toEqual({
      path: "a/first.bin",
      size: 4,
      md5: MD5_REAL,
      sha256: SHA256,
      contentType: "application/octet-stream",
    });

    if (!etag) throw new Error("expected ETag");
    const cached = await new GenericAdapter().handle(
      { entry: { method: "GET", pattern: "/", handlerId: "index" }, params: {}, path: "/" },
      new Request("https://registry.test/", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /?prefix= filters the listing to a directory", async () => {
    const ctx = genericContext();
    ctx.data.packages.list = async () => [
      { id: "pkg_docs", orgId: "org_1", repositoryId: "repo_1", name: "docs/readme.md" },
      { id: "pkg_bin", orgId: "org_1", repositoryId: "repo_1", name: "bin/app" },
    ];
    ctx.data.versions.listLiveForPackages = async (pkgs) =>
      new Map(pkgs.map((p) => [p.id, [versionRow(metaFor(p.name))]]));

    const res = await new GenericAdapter().handle(
      { entry: { method: "GET", pattern: "/", handlerId: "index" }, params: {}, path: "/" },
      new Request("https://registry.test/?prefix=docs"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await readIndex(res);
    expect(body.prefix).toBe("docs");
    expect(body.entries.map((e) => e.path)).toEqual(["docs/readme.md"]);
  });

  test("GET /?prefix=docs/ accepts a trailing slash and normalizes it away", async () => {
    const ctx = genericContext();
    ctx.data.packages.list = async () => [
      { id: "pkg_docs", orgId: "org_1", repositoryId: "repo_1", name: "docs/readme.md" },
      { id: "pkg_bin", orgId: "org_1", repositoryId: "repo_1", name: "bin/app" },
    ];
    ctx.data.versions.listLiveForPackages = async (pkgs) =>
      new Map(pkgs.map((p) => [p.id, [versionRow(metaFor(p.name))]]));

    const res = await new GenericAdapter().handle(
      { entry: { method: "GET", pattern: "/", handlerId: "index" }, params: {}, path: "/" },
      new Request("https://registry.test/?prefix=docs/"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await readIndex(res);
    expect(body.prefix).toBe("docs");
    expect(body.entries.map((e) => e.path)).toEqual(["docs/readme.md"]);
  });

  test("GET /<path> serves the stored blob with checksum sidecar headers", async () => {
    const ctx = genericContext();
    const served: { digest?: string; contentType?: string } = {};
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("releases/app.bin");
      return pkgRow(name);
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe(GENERIC_VERSION);
      return versionRow(metaFor("releases/app.bin", "application/wasm"));
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType, extraHeaders }) => {
      served.digest = digest;
      served.contentType = contentType;
      return new Response("blob-bytes", {
        headers: { "content-type": contentType, ...extraHeaders },
      });
    };

    const res = await new GenericAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
        params: { path: "releases/app.bin" },
        path: "/releases/app.bin",
      },
      new Request("https://registry.test/releases/app.bin"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(served.contentType).toBe("application/wasm");
    expect(res.headers.get("etag")).toBe(`"${SHA256}"`);
    expect(res.headers.get("x-checksum-md5")).toBe(MD5_REAL);
    expect(res.headers.get("x-checksum-sha256")).toBe(SHA256);
    expect(res.headers.get("x-checksum-sha512")).toBe(SHA512_REAL);
    // A GET streams the body chunked, so no content-length is advertised.
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("blob-bytes");
  });

  test("GET /<path> with a matching If-None-Match short-circuits to 304", async () => {
    const ctx = genericContext();
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async () => versionRow(metaFor("app.bin"));
    ctx.data.content.blobRefExists = async () => true;
    // serveBlobIfClean invokes notModified() before serving; mirror the core
    // contract by honoring a returned Response so the body is never streamed.
    ctx.data.content.serveBlobIfClean = async ({ contentType, notModified }) => {
      const not = notModified?.();
      if (not) return not;
      return new Response("blob-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new GenericAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
        params: { path: "app.bin" },
        path: "/app.bin",
      },
      new Request("https://registry.test/app.bin", {
        headers: { "if-none-match": `"${SHA256}"` },
      }),
      ctx,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`"${SHA256}"`);
    expect(await res.text()).toBe("");
  });

  test("GET /<path> throws NOT_FOUND when the path is unknown (singleError JSON shape)", async () => {
    const ctx = genericContext();
    ctx.data.packages.findByName = async () => null;
    // Throwing Errors.notFound() (rather than a hand-rolled plain-text 404) lets
    // the dispatch layer serialize the module's declared singleError JSON shape.
    await expect(
      new GenericAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
          params: { path: "missing.bin" },
          path: "/missing.bin",
        },
        new Request("https://registry.test/missing.bin"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("GET /<path> throws NOT_FOUND when the package exists but its metadata is missing", async () => {
    const ctx = genericContext();
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async () => null;
    await expect(
      new GenericAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
          params: { path: "stale.bin" },
          path: "/stale.bin",
        },
        new Request("https://registry.test/stale.bin"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("GET /<path> with a traversal path throws NAME_INVALID", async () => {
    const ctx = genericContext();
    await expect(
      new GenericAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
          params: { path: "../etc/passwd" },
          path: "/../etc/passwd",
        },
        new Request("https://registry.test/../etc/passwd"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("PUT /<path> stores the blob and returns 201 with checksums", async () => {
    const ctx = genericContext();
    const captured: { metadata?: Record<string, unknown>; previousDigest?: string | null } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.findLive = async () => null;
    ctx.data.versions.upsertWithBlobRef = async (input) => {
      captured.metadata = input.metadata;
      captured.previousDigest = input.blob.previousDigest;
      return {
        stored: {
          digest: DIGEST,
          size: 4,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        } satisfies RegistryStoredBlob,
        versionId: "ver_1",
      };
    };

    const res = await new GenericAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:path+", handlerId: "publish" },
        params: { path: "releases/app.bin" },
        path: "/releases/app.bin",
      },
      new Request("https://registry.test/releases/app.bin", {
        method: "PUT",
        headers: { "content-type": "application/wasm" },
        body: DATA,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      path: "releases/app.bin",
      size: 4,
      sha256: SHA256,
      sha512: SHA512_REAL,
    });
    expect(captured.previousDigest).toBe(null);
    expect(captured.metadata).toMatchObject({
      path: "releases/app.bin",
      blobDigest: DIGEST,
      md5: MD5_REAL,
      sha256: SHA256,
      sha512: SHA512_REAL,
      size: 4,
      contentType: "application/wasm",
    });
  });

  test("PUT /<path> overwrites: passes the previous blob digest for ref release, returns 200", async () => {
    const ctx = genericContext();
    const captured: { previousDigest?: string | null } = {};
    const oldDigest = `sha256:${"b".repeat(64)}`;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.findLive = async () =>
      versionRow({ ...metaFor("app.bin"), blobDigest: oldDigest });
    ctx.data.versions.upsertWithBlobRef = async (input) => {
      captured.previousDigest = input.blob.previousDigest;
      return {
        stored: {
          digest: DIGEST,
          size: 4,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        } satisfies RegistryStoredBlob,
        versionId: "ver_1",
      };
    };

    const res = await new GenericAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:path+", handlerId: "publish" },
        params: { path: "app.bin" },
        path: "/app.bin",
      },
      new Request("https://registry.test/app.bin", { method: "PUT", body: DATA }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(captured.previousDigest).toBe(oldDigest);
  });

  test("PUT /<path> rejects an oversized body with 413", async () => {
    const ctx = genericContext();
    ctx.limits = { ...ctx.limits, maxUploadBytes: 2 };
    const res = await new GenericAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:path+", handlerId: "publish" },
        params: { path: "big.bin" },
        path: "/big.bin",
      },
      new Request("https://registry.test/big.bin", { method: "PUT", body: DATA }),
      ctx,
    );
    expect(res.status).toBe(413);
  });

  test("HEAD /<path> resolves the stored blob without a redirect and advertises size + checksums", async () => {
    const ctx = genericContext();
    const served: { redirect?: boolean } = {};
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async () => versionRow(metaFor("app.bin"));
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ contentType, redirect, extraHeaders }) => {
      served.redirect = redirect;
      return new Response(null, { headers: { "content-type": contentType, ...extraHeaders } });
    };
    const res = await new GenericAdapter().handle(
      {
        entry: { method: "HEAD", pattern: "/:path+", handlerId: "head" },
        params: { path: "app.bin" },
        path: "/app.bin",
      },
      new Request("https://registry.test/app.bin", { method: "HEAD" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.redirect).toBe(false);
    // A HEAD carries no body, so the exact size is surfaced for the client to
    // size the artifact before issuing the GET.
    expect(res.headers.get("content-length")).toBe(String(DATA.length));
    expect(res.headers.get("etag")).toBe(`"${SHA256}"`);
    expect(res.headers.get("x-checksum-md5")).toBe(MD5_REAL);
    expect(res.headers.get("x-checksum-sha256")).toBe(SHA256);
    expect(res.headers.get("x-checksum-sha512")).toBe(SHA512_REAL);
  });

  test("DELETE /<path> tombstones the version, releases the ref, returns 204", async () => {
    const ctx = genericContext();
    const released: { digest?: string; scope?: string } = {};
    const tombstoned: { digest?: string } = {};
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async () => versionRow(metaFor("app.bin"));
    ctx.data.contentStore.markPackageVersionsDeletedByDigest = async ({ digest }) => {
      tombstoned.digest = digest;
      return 1;
    };
    ctx.data.content.releaseBlobRef = async ({ digest, scope }) => {
      released.digest = digest;
      released.scope = scope;
    };
    const res = await new GenericAdapter().handle(
      {
        entry: { method: "DELETE", pattern: "/:path+", handlerId: "remove" },
        params: { path: "app.bin" },
        path: "/app.bin",
      },
      new Request("https://registry.test/app.bin", { method: "DELETE" }),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(tombstoned.digest).toBe(DIGEST);
    expect(released.digest).toBe(DIGEST);
    expect(released.scope).toBe("generic/app.bin");
  });

  test("DELETE /<path> throws NOT_FOUND when the path is unknown", async () => {
    const ctx = genericContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new GenericAdapter().handle(
        {
          entry: { method: "DELETE", pattern: "/:path+", handlerId: "remove" },
          params: { path: "missing.bin" },
          path: "/missing.bin",
        },
        new Request("https://registry.test/missing.bin", { method: "DELETE" }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("proxyIngest mirrors an upstream path into the repo", async () => {
    const ctx = genericContext();
    const stored: { path?: string; data?: Uint8Array; contentType?: string } = {};
    ctx.limits = { ...ctx.limits, enforcePublicNetwork: false };
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.findLive = async () => null;
    ctx.data.versions.upsertWithBlobRef = async (input) => {
      stored.path = input.package.name;
      stored.data = input.blob.data;
      stored.contentType = input.blob.mediaType;
      return {
        stored: {
          digest: DIGEST,
          size: 4,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        } satisfies RegistryStoredBlob,
        versionId: "ver_1",
      };
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(DATA, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
      })) as unknown as typeof fetch;
    try {
      const ok = await requireProxyIngest(new GenericAdapter())(
        "releases/app.bin",
        "https://upstream.example.com/files",
        ctx,
      );
      expect(ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(stored.path).toBe("releases/app.bin");
    expect(stored.contentType).toBe("application/octet-stream");
    expect(Array.from(stored.data ?? [])).toEqual([1, 2, 3, 4]);
  });

  test("proxyIngest returns false for an invalid path", async () => {
    const ctx = genericContext();
    const ok = await requireProxyIngest(new GenericAdapter())(
      "../escape",
      "https://upstream.example.com/files",
      ctx,
    );
    expect(ok).toBe(false);
  });

  test("download route is wired for proxy pull-through with the correct package param", async () => {
    // Lock in the contract the agnostic proxy dispatcher relies on: it only
    // mirrors from upstream when the matched route carries proxyRefreshTrigger,
    // and it derives the package name as params[entry.packageParam ?? "pkg"].
    // Reproduce that derivation against the REAL route entry so a regression in
    // either flag (missing trigger, or the param defaulting to the absent "pkg")
    // is caught here, not only in a live proxy repo.
    const adapter = new GenericAdapter();
    const proxyIngest = requireProxyIngest(adapter);
    const downloadEntry = adapter
      .routes()
      .find((r) => r.method === "GET" && r.handlerId === "download");
    if (!downloadEntry) throw new Error("expected a download route");
    expect(downloadEntry.proxyRefreshTrigger).toBe(true);

    const params = { path: "releases/app.bin" };
    const dispatcherPackageName = params[(downloadEntry.packageParam ?? "pkg") as "path"] ?? "";
    expect(dispatcherPackageName).toBe("releases/app.bin");

    const ctx = genericContext();
    ctx.limits = { ...ctx.limits, enforcePublicNetwork: false };
    const stored: { path?: string } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.findLive = async () => null;
    ctx.data.versions.upsertWithBlobRef = async (input) => {
      stored.path = input.package.name;
      return {
        stored: {
          digest: DIGEST,
          size: 4,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        } satisfies RegistryStoredBlob,
        versionId: "ver_1",
      };
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(DATA, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
      })) as unknown as typeof fetch;
    try {
      // This is exactly the call dispatchProxy makes on a read miss.
      const ok = await proxyIngest(
        dispatcherPackageName,
        "https://upstream.example.com/files",
        ctx,
      );
      expect(ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The mirrored blob is stored under the matched path (not the empty "" that a
    // missing packageParam would have produced).
    expect(stored.path).toBe("releases/app.bin");
  });

  test("proxyIngest rejects a loopback upstream under public-network enforcement", async () => {
    const ctx = genericContext();
    // With enforcement on, safeFetch must block a private/loopback upstream host
    // before any bytes are read — no fetch stub, so a real attempt would throw.
    ctx.limits = { ...ctx.limits, enforcePublicNetwork: true };
    const ok = await requireProxyIngest(new GenericAdapter())(
      "releases/app.bin",
      "http://127.0.0.1:9000/files",
      ctx,
    );
    expect(ok).toBe(false);
  });
});
