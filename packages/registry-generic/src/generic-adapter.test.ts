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

const SHA512_REAL = sha512hex(DATA);

function metaFor(path: string, contentType = "application/octet-stream") {
  return buildGenericVersionMeta({
    path,
    blobDigest: DIGEST,
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

interface IndexBody {
  prefix: string;
  entries: { path: string; size: number; sha256: string; contentType: string }[];
}

async function readIndex(res: Response): Promise<IndexBody> {
  return (await res.json()) as IndexBody;
}

describe("Generic adapter", () => {
  test("declares index, download, head, publish, and delete routes (index before :path+)", () => {
    expect(new GenericAdapter().routes()).toEqual([
      { method: "GET", pattern: "/", handlerId: "index" },
      { method: "GET", pattern: "/:path+", handlerId: "download" },
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
    ctx.data.packages.listNames = async () => [{ name: "z/last.bin" }, { name: "a/first.bin" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async (pkg) => versionRow(metaFor(pkg.name));

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
    ctx.data.packages.listNames = async () => [{ name: "docs/readme.md" }, { name: "bin/app" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async (pkg) => versionRow(metaFor(pkg.name));

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
    expect(res.headers.get("x-checksum-sha256")).toBe(SHA256);
    expect(res.headers.get("x-checksum-sha512")).toBe(SHA512_REAL);
    expect(await res.text()).toBe("blob-bytes");
  });

  test("GET /<path> 404s when the path is unknown", async () => {
    const ctx = genericContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new GenericAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:path+", handlerId: "download" },
        params: { path: "missing.bin" },
        path: "/missing.bin",
      },
      new Request("https://registry.test/missing.bin"),
      ctx,
    );
    expect(res.status).toBe(404);
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

  test("HEAD /<path> resolves the stored blob without a redirect", async () => {
    const ctx = genericContext();
    const served: { redirect?: boolean } = {};
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.findLive = async () => versionRow(metaFor("app.bin"));
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ contentType, redirect }) => {
      served.redirect = redirect;
      return new Response(null, { headers: { "content-type": contentType } });
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

  test("DELETE /<path> 404s when the path is unknown", async () => {
    const ctx = genericContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new GenericAdapter().handle(
      {
        entry: { method: "DELETE", pattern: "/:path+", handlerId: "remove" },
        params: { path: "missing.bin" },
        path: "/missing.bin",
      },
      new Request("https://registry.test/missing.bin", { method: "DELETE" }),
      ctx,
    );
    expect(res.status).toBe(404);
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
      const ok = await new GenericAdapter().proxyIngest(
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
    const ok = await new GenericAdapter().proxyIngest(
      "../escape",
      "https://upstream.example.com/files",
      ctx,
    );
    expect(ok).toBe(false);
  });
});
