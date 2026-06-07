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

/** A fixture `.apk` plus the metadata derived from it — so tests can tie the
 * served index `C:`/`S:`/`I:` back to the exact package bytes. */
function helloFixture(arch = "x86_64") {
  const apk = buildApkFixture({
    name: "hello",
    version: "1.2.3-r0",
    arch,
    description: "demo",
    depends: ["libc", "!evil-conflict"],
    size: 9000,
  });
  const parsed = parseApk(apk);
  if (!parsed.ok) throw new Error("fixture failed to parse");
  const meta = buildAlpineVersionMeta(parsed.info, {
    digest: DIGEST,
    checksum: parsed.checksum,
    size: apk.byteLength,
    filename: "hello-1.2.3-r0.apk",
  });
  return { apk, parsed, meta };
}

function helloMeta(arch = "x86_64") {
  return helloFixture(arch).meta;
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

  test("declares only the virtualizable capability (no dishonest proxyable)", () => {
    // There is no proxyIngest, so advertising proxyable would be a dead capability
    // the platform rejects at proxy-repo creation. Match registry-apt/registry-maven.
    expect(new AlpineAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: false,
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

  test("named-publish write permission targets the arch/filename artifact ref", () => {
    const adapter = new AlpineAdapter();
    const match = {
      entry: { method: "PUT", pattern: "/:arch/:filename", handlerId: "publishNamed" },
      params: { arch: "x86_64", filename: "hello-1.2.3-r0.apk" },
      path: "/x86_64/hello-1.2.3-r0.apk",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("PUT", match)).toEqual({
      action: "write",
      resource: { type: "artifact", artifactRef: "x86_64/hello-1.2.3-r0.apk" },
    });
  });

  test("unnamed-publish write permission stays unscoped (no filename segment)", () => {
    const adapter = new AlpineAdapter();
    const match = {
      entry: { method: "PUT", pattern: "/:arch", handlerId: "publish" },
      params: { arch: "x86_64" },
      path: "/x86_64",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("PUT", match)).toEqual({ action: "write" });
  });

  test("GET /<arch>/APKINDEX.tar.gz regenerates the index for the arch, cacheable", async () => {
    const ctx = alpineContext();
    const { apk, meta } = helloFixture("x86_64");
    ctx.data.packages.listNames = async () => [{ name: "hello" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(meta)];

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
    // C: must equal the Q1 checksum apk recomputes over the downloaded .apk's
    // control segment — tie the served index field to the real package bytes.
    const fromBytes = parseApk(apk);
    if (!fromBytes.ok) throw new Error("fixture failed to parse");
    expect(text).toContain(`C:${fromBytes.checksum}`);
    // S: is the compressed blob size; I: is the .PKGINFO installed size (9000).
    expect(text).toContain(`S:${apk.byteLength}`);
    expect(text).toContain("I:9000");
    // The D: conflict marker survives verbatim — `!evil-conflict` must NOT be
    // emitted as a positive `evil-conflict` dependency.
    expect(text).toContain("D:libc !evil-conflict");

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
    const committed: { metadata?: Record<string, unknown>; scan?: unknown; version?: string } = {};
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
      committed.version = input.version;
      return { versionId: "ver_1" };
    };

    const apk = buildApkFixture({
      name: "hello",
      version: "1.2.3-r0",
      arch: "x86_64",
      description: "demo",
      depends: ["libc", "!evil"],
      size: 9000,
      extraFields: { provides: "so:libhello.so.1" },
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
      // Conflict marker preserved, provides + installed size threaded through.
      depends: ["libc", "!evil"],
      provides: ["so:libhello.so.1"],
      installedSize: 9000,
    });
    // The stored version key is arch-qualified so the same apk version can be
    // published for multiple arches; the metadata/index version stays bare.
    expect(committed.version).toBe("x86_64/1.2.3-r0");
  });

  test("the same apk version publishes for multiple arches without conflict", async () => {
    const seen: Array<{ namespace?: string | null; version: string }> = [];
    const publishArch = async (arch: string) => {
      const ctx = alpineContext();
      ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
      // Conflict only when this exact (package, arch-qualified version) already exists.
      ctx.data.versions.exists = async (_pkg, version) => seen.some((s) => s.version === version);
      ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
        digest: DIGEST,
        size: 9000,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      });
      ctx.data.versions.commitOrReleaseBlob = async (input) => {
        seen.push({ version: input.version });
        return { versionId: `ver_${seen.length}` };
      };
      const apk = buildApkFixture({ name: "hello", version: "1.2.3-r0", arch });
      return new AlpineAdapter().handle(
        {
          entry: { method: "PUT", pattern: "/:arch", handlerId: "publish" },
          params: { arch },
          path: `/${arch}`,
        },
        new Request(`https://r.test/${arch}`, { method: "PUT", body: apk }),
        ctx,
      );
    };

    expect((await publishArch("x86_64")).status).toBe(201);
    expect((await publishArch("aarch64")).status).toBe(201);
    expect(seen.map((s) => s.version)).toEqual(["x86_64/1.2.3-r0", "aarch64/1.2.3-r0"]);
    // Re-publishing the same (arch, version) still conflicts.
    expect((await publishArch("x86_64")).status).toBe(409);
  });

  test("PUT /<arch>/<filename> rejects a non-.apk path segment", async () => {
    const ctx = alpineContext();
    const apk = buildApkFixture({ name: "hello", version: "1.2.3-r0", arch: "x86_64" });
    await expect(
      new AlpineAdapter().handle(
        {
          entry: { method: "PUT", pattern: "/:arch/:filename", handlerId: "publishNamed" },
          params: { arch: "x86_64", filename: "not-an-apk.txt" },
          path: "/x86_64/not-an-apk.txt",
        },
        new Request("https://r.test/x86_64/not-an-apk.txt", { method: "PUT", body: apk }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("PUT /<arch>/<filename> rejects when the path filename names a different package", async () => {
    // Confused-deputy guard: authorization on publishNamed is scoped to the URL
    // filename segment, so a body whose .PKGINFO names a different package must be
    // rejected (it would otherwise write to a scope the token was not authorized for).
    const ctx = alpineContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    const apk = buildApkFixture({ name: "evil", version: "9.9.9-r0", arch: "x86_64" });
    const res = await new AlpineAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:arch/:filename", handlerId: "publishNamed" },
        params: { arch: "x86_64", filename: "hello-1.2.3-r0.apk" },
        path: "/x86_64/hello-1.2.3-r0.apk",
      },
      new Request("https://r.test/x86_64/hello-1.2.3-r0.apk", { method: "PUT", body: apk }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "upload filename 'hello-1.2.3-r0.apk' does not match package 'evil-9.9.9-r0.apk'",
    });
  });

  test("PUT /<arch>/<filename> accepts a matching path filename", async () => {
    const ctx = alpineContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 9000,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });
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
    expect(res.status).toBe(201);
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
