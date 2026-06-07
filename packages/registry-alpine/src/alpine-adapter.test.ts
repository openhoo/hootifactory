import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { AlpineAdapter } from "./alpine-adapter";
import { buildAlpineVersionMeta } from "./alpine-meta";
import { buildApkFixture } from "./apk-fixture";
import { parseApk } from "./apk-parse";

const DIGEST = `sha256:${"a".repeat(64)}`;

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: "1.2.3-r0",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: "pkg_hello",
    version: "1.2.3-r0",
    metadata,
    sizeBytes: 9000,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function helloMeta(arch = "x86_64") {
  const apk = buildApkFixture({
    name: "hello",
    version: "1.2.3-r0",
    arch,
    description: "demo",
    depends: ["libc"],
    size: 9000,
  });
  const parsed = parseApk(apk);
  if (!parsed.ok) throw new Error("fixture failed to parse");
  return buildAlpineVersionMeta(parsed.info, {
    digest: DIGEST,
    checksum: parsed.checksum,
    size: apk.byteLength,
    filename: "hello-1.2.3-r0.apk",
  });
}

function alpineContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "alpine", mountPath: "alpine/private" };
  return ctx;
}

const INDEX_MATCH = {
  method: "GET",
  pattern: "/:arch/APKINDEX.tar.gz",
  handlerId: "index",
} as const;
const DOWNLOAD_MATCH = {
  method: "GET",
  pattern: "/:arch/:filename",
  handlerId: "download",
} as const;

describe("Alpine adapter", () => {
  test("declares index, download, and publish routes (index before :filename)", () => {
    expect(new AlpineAdapter().routes()).toEqual([
      { method: "GET", pattern: "/:arch/APKINDEX.tar.gz", handlerId: "index" },
      { method: "GET", pattern: "/:arch/:filename", handlerId: "download" },
      { method: "PUT", pattern: "/:arch/:filename", handlerId: "publishNamed" },
      { method: "PUT", pattern: "/:arch", handlerId: "publish" },
    ]);
  });

  test("declares the proxyable + virtualizable capabilities", () => {
    expect(new AlpineAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
  });

  test("reads use read permission, writes use write, with basic auth", () => {
    const adapter = new AlpineAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the arch/filename artifact ref", () => {
    const adapter = new AlpineAdapter();
    const match = {
      entry: DOWNLOAD_MATCH,
      params: { arch: "x86_64", filename: "hello-1.2.3-r0.apk" },
      path: "/x86_64/hello-1.2.3-r0.apk",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "x86_64/hello-1.2.3-r0.apk" },
    });
  });

  test("GET /<arch>/APKINDEX.tar.gz regenerates the index for the arch, cacheable", async () => {
    const ctx = alpineContext();
    ctx.data.packages.listNames = async () => [{ name: "hello" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(helloMeta("x86_64"))];

    const res = await new AlpineAdapter().handle(
      { entry: INDEX_MATCH, params: { arch: "x86_64" }, path: "/x86_64/APKINDEX.tar.gz" },
      new Request("https://r.test/x86_64/APKINDEX.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    const tar = gunzipSync(new Uint8Array(await res.arrayBuffer()));
    const text = new TextDecoder().decode(tar);
    expect(text).toContain("P:hello");
    expect(text).toContain("V:1.2.3-r0");
    expect(text).toContain("A:x86_64");
    expect(text).toContain("D:libc");

    if (!etag) throw new Error("expected etag");
    const cached = await new AlpineAdapter().handle(
      { entry: INDEX_MATCH, params: { arch: "x86_64" }, path: "/x86_64/APKINDEX.tar.gz" },
      new Request("https://r.test/x86_64/APKINDEX.tar.gz", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("APKINDEX excludes versions whose stored arch differs", async () => {
    const ctx = alpineContext();
    ctx.data.packages.listNames = async () => [{ name: "hello" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(helloMeta("aarch64"))];

    const res = await new AlpineAdapter().handle(
      { entry: INDEX_MATCH, params: { arch: "x86_64" }, path: "/x86_64/APKINDEX.tar.gz" },
      new Request("https://r.test/x86_64/APKINDEX.tar.gz"),
      ctx,
    );
    const text = new TextDecoder().decode(gunzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(text).not.toContain("P:hello");
  });

  test("GET /<arch>/<file>.apk serves the matching stored blob", async () => {
    const ctx = alpineContext();
    const served: { digest?: string } = {};
    ctx.data.packages.listNames = async () => [{ name: "hello" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(helloMeta("x86_64"))];
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("apk-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new AlpineAdapter().handle(
      {
        entry: DOWNLOAD_MATCH,
        params: { arch: "x86_64", filename: "hello-1.2.3-r0.apk" },
        path: "/x86_64/hello-1.2.3-r0.apk",
      },
      new Request("https://r.test/x86_64/hello-1.2.3-r0.apk"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("apk-bytes");
  });

  test("download 404s when no live version matches the filename", async () => {
    const ctx = alpineContext();
    ctx.data.packages.listNames = async () => [{ name: "hello" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(helloMeta("x86_64"))];

    const res = await new AlpineAdapter().handle(
      {
        entry: DOWNLOAD_MATCH,
        params: { arch: "x86_64", filename: "other-9.9.9-r0.apk" },
        path: "/x86_64/other-9.9.9-r0.apk",
      },
      new Request("https://r.test/x86_64/other-9.9.9-r0.apk"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download with a non-.apk filename throws NAME_INVALID", async () => {
    const ctx = alpineContext();
    await expect(
      new AlpineAdapter().handle(
        {
          entry: DOWNLOAD_MATCH,
          params: { arch: "x86_64", filename: "evil.txt" },
          path: "/x86_64/evil.txt",
        },
        new Request("https://r.test/x86_64/evil.txt"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("PUT /<arch> publishes a .apk and stores derived metadata", async () => {
    const ctx = alpineContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 9000,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const apk = buildApkFixture({
      name: "hello",
      version: "1.2.3-r0",
      arch: "x86_64",
      description: "demo",
      depends: ["libc"],
    });
    const res = await new AlpineAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:arch", handlerId: "publish" },
        params: { arch: "x86_64" },
        path: "/x86_64",
      },
      new Request("https://r.test/x86_64", { method: "PUT", body: apk }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      name: "hello",
      version: "1.2.3-r0",
      arch: "x86_64",
    });
    expect(committed.scan).toEqual({
      name: "hello",
      version: "1.2.3-r0",
      mediaType: "application/vnd.alpine.apk",
    });
    expect(committed.metadata).toMatchObject({
      name: "hello",
      version: "1.2.3-r0",
      arch: "x86_64",
      blobDigest: DIGEST,
      filename: "hello-1.2.3-r0.apk",
      depends: ["libc"],
    });
  });

  test("PUT rejects a package whose arch differs from the upload arch", async () => {
    const ctx = alpineContext();
    const apk = buildApkFixture({ name: "hello", version: "1.2.3-r0", arch: "aarch64" });
    const res = await new AlpineAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:arch", handlerId: "publish" },
        params: { arch: "x86_64" },
        path: "/x86_64",
      },
      new Request("https://r.test/x86_64", { method: "PUT", body: apk }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("PUT returns 422 for malformed (non-gzip) bodies", async () => {
    const ctx = alpineContext();
    const res = await new AlpineAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:arch", handlerId: "publish" },
        params: { arch: "x86_64" },
        path: "/x86_64",
      },
      new Request("https://r.test/x86_64", { method: "PUT", body: new Uint8Array([1, 2, 3]) }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  test("PUT returns 409 when the version already exists", async () => {
    const ctx = alpineContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;
    const apk = buildApkFixture({ name: "hello", version: "1.2.3-r0", arch: "x86_64" });
    const res = await new AlpineAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:arch/:filename", handlerId: "publishNamed" },
        params: { arch: "x86_64", filename: "hello-1.2.3-r0.apk" },
        path: "/x86_64/hello-1.2.3-r0.apk",
      },
      new Request("https://r.test/x86_64/hello-1.2.3-r0.apk", { method: "PUT", body: apk }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("scan.referencedDigests surfaces the stored blob digest", () => {
    const scan = new AlpineAdapter().scan;
    expect(scan?.referencedDigests?.({ blobDigest: DIGEST })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ name: "hello" })).toEqual([]);
  });
});
