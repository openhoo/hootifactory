import { describe, expect, test } from "bun:test";
import {
  computeDigest,
  type RegistryPackageRow,
  type RegistryPackageVersionRow,
  type RegistryStoredBlob,
  type RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { OpamAdapter } from "./opam-adapter";
import { buildOpamVersionMeta, OpamPublishManifestSchema } from "./opam-validation";
import { buildMultipartBody } from "./opam-validation.test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: "5.6.1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  metadata: Record<string, unknown>,
  version = "5.6.1",
): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_lwt",
    version,
    metadata,
    sizeBytes: 4,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function storedMeta(name = "lwt", version = "5.6.1") {
  return buildOpamVersionMeta(
    OpamPublishManifestSchema.parse({
      name,
      version,
      synopsis: "Promises and concurrency",
      depends: [{ name: "ocaml", constraint: '>= "4.08"' }],
    }),
    { digest: DIGEST, sha256: HEX, filename: `${name}-${version}.tar.gz` },
  );
}

function opamContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "opam", mountPath: "opam/private" };
  return ctx;
}

function decodeTar(tar: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(
      decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(),
      8,
    );
    const dataStart = offset + 512;
    out.set(path, decoder.decode(tar.subarray(dataStart, dataStart + size)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("opam adapter", () => {
  test("declares index, opamFile, archive, and publish routes (index before catch-alls)", () => {
    expect(new OpamAdapter().routes()).toEqual([
      { method: "GET", pattern: "/index.tar.gz", handlerId: "index" },
      { method: "GET", pattern: "/packages/:pkg/:nv/opam", handlerId: "opamFile" },
      { method: "GET", pattern: "/archives/:name/:version/:filename", handlerId: "archive" },
      { method: "PUT", pattern: "/upload", handlerId: "publish" },
    ]);
  });

  test("exposes only the implemented capabilities (virtualizable, not proxyable)", () => {
    // `proxyable` is intentionally NOT declared: the adapter wires no
    // `.proxyIngest(...)` and does no upstream fetch, so advertising a proxy
    // capability it cannot honor would be dishonest.
    expect(new OpamAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: false,
      virtualizable: true,
    });
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new OpamAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("archive permission targets the artifact ref", () => {
    const adapter = new OpamAdapter();
    const match = {
      entry: {
        method: "GET",
        pattern: "/archives/:name/:version/:filename",
        handlerId: "archive",
      },
      params: { name: "lwt", version: "5.6.1", filename: "lwt-5.6.1.tar.gz" },
      path: "/archives/lwt/5.6.1/lwt-5.6.1.tar.gz",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "lwt",
        artifactRef: "lwt@5.6.1/lwt-5.6.1.tar.gz",
      },
    });
  });

  test("opamFile permission targets the package", () => {
    const adapter = new OpamAdapter();
    const match = {
      entry: { method: "GET", pattern: "/packages/:pkg/:nv/opam", handlerId: "opamFile" },
      params: { pkg: "lwt", nv: "lwt.5.6.1" },
      path: "/packages/lwt/lwt.5.6.1/opam",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "lwt" },
    });
  });

  test("GET /index.tar.gz serves a gzipped repo tarball, ordered + cacheable", async () => {
    const ctx = opamContext();
    ctx.data.packages.list = async () => [pkgRow("lwt"), pkgRow("dune")];
    ctx.data.versions.listLiveForPackages = async (pkgs, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      return new Map(pkgs.map((pkg) => [pkg.id, [versionRow(storedMeta(pkg.name), "5.6.1")]]));
    };

    const res = await new OpamAdapter().handle(
      {
        entry: { method: "GET", pattern: "/index.tar.gz", handlerId: "index" },
        params: {},
        path: "/index.tar.gz",
      },
      new Request("https://registry.test/index.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    const tar = decodeTar(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(tar.has("repo")).toBe(true);
    expect(tar.has("packages/lwt/lwt.5.6.1/opam")).toBe(true);
    expect(tar.has("packages/dune/dune.5.6.1/opam")).toBe(true);
    expect(tar.get("packages/lwt/lwt.5.6.1/opam")).toContain(
      'src: "https://registry.example.test/opam/private/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"',
    );

    if (!etag) throw new Error("expected ETag");
    const cached = await new OpamAdapter().handle(
      {
        entry: { method: "GET", pattern: "/index.tar.gz", handlerId: "index" },
        params: {},
        path: "/index.tar.gz",
      },
      new Request("https://registry.test/index.tar.gz", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /packages/<pkg>/<pkg>.<version>/opam serves the opam file", async () => {
    const ctx = opamContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("lwt");
      return pkgRow("lwt");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("5.6.1");
      return versionRow(storedMeta());
    };

    const res = await new OpamAdapter().handle(
      {
        entry: { method: "GET", pattern: "/packages/:pkg/:nv/opam", handlerId: "opamFile" },
        params: { pkg: "lwt", nv: "lwt.5.6.1" },
        path: "/packages/lwt/lwt.5.6.1/opam",
      },
      new Request("https://registry.test/packages/lwt/lwt.5.6.1/opam"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain('opam-version: "2.0"');
    expect(body).toContain('name: "lwt"');
    expect(body).toContain('version: "5.6.1"');
    expect(body).toContain('depends: [ "ocaml" { >= "4.08" } ]');
    expect(body).toContain(
      'src: "https://registry.example.test/opam/private/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"',
    );
    expect(body).toContain(`checksum: [ "sha256=${HEX}" ]`);
  });

  test("opamFile 404s when the name.version segment does not start with <pkg>.", async () => {
    const ctx = opamContext();
    await expect(
      new OpamAdapter().handle(
        {
          entry: { method: "GET", pattern: "/packages/:pkg/:nv/opam", handlerId: "opamFile" },
          params: { pkg: "lwt", nv: "dune.1.0.0" },
          path: "/packages/lwt/dune.1.0.0/opam",
        },
        new Request("https://registry.test/packages/lwt/dune.1.0.0/opam"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("opamFile 404s when the package is unknown", async () => {
    const ctx = opamContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new OpamAdapter().handle(
      {
        entry: { method: "GET", pattern: "/packages/:pkg/:nv/opam", handlerId: "opamFile" },
        params: { pkg: "missing", nv: "missing.1.0.0" },
        path: "/packages/missing/missing.1.0.0/opam",
      },
      new Request("https://registry.test/packages/missing/missing.1.0.0/opam"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("archive resolves the stored blob digest for the matching filename", async () => {
    const ctx = opamContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("lwt");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("5.6.1");
      return versionRow(storedMeta());
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("blob-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new OpamAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/archives/:name/:version/:filename",
          handlerId: "archive",
        },
        params: { name: "lwt", version: "5.6.1", filename: "lwt-5.6.1.tar.gz" },
        path: "/archives/lwt/5.6.1/lwt-5.6.1.tar.gz",
      },
      new Request("https://registry.test/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("blob-bytes");
  });

  test("archive serves a non-gzip extension with the matching content-type", async () => {
    const ctx = opamContext();
    const meta = buildOpamVersionMeta(
      OpamPublishManifestSchema.parse({ name: "lwt", version: "5.6.1" }),
      { digest: DIGEST, sha256: HEX, filename: "lwt-5.6.1.zip" },
    );
    let servedContentType: string | undefined;
    ctx.data.packages.findByName = async () => pkgRow("lwt");
    ctx.data.versions.findLive = async () => versionRow({ ...meta });
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ contentType }) => {
      servedContentType = contentType;
      return new Response("blob-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new OpamAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/archives/:name/:version/:filename",
          handlerId: "archive",
        },
        params: { name: "lwt", version: "5.6.1", filename: "lwt-5.6.1.zip" },
        path: "/archives/lwt/5.6.1/lwt-5.6.1.zip",
      },
      new Request("https://registry.test/archives/lwt/5.6.1/lwt-5.6.1.zip"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(servedContentType).toBe("application/zip");
  });

  test("archive 404s when the requested filename does not match the stored archive", async () => {
    const ctx = opamContext();
    ctx.data.packages.findByName = async () => pkgRow("lwt");
    ctx.data.versions.findLive = async () => versionRow(storedMeta());
    const res = await new OpamAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/archives/:name/:version/:filename",
          handlerId: "archive",
        },
        params: { name: "lwt", version: "5.6.1", filename: "other.tar.gz" },
        path: "/archives/lwt/5.6.1/other.tar.gz",
      },
      new Request("https://registry.test/archives/lwt/5.6.1/other.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("archive 404s when the version is missing or not live", async () => {
    const ctx = opamContext();
    ctx.data.packages.findByName = async () => pkgRow("lwt");
    ctx.data.versions.findLive = async () => null;
    const res = await new OpamAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/archives/:name/:version/:filename",
          handlerId: "archive",
        },
        params: { name: "lwt", version: "9.9.9", filename: "lwt-9.9.9.tar.gz" },
        path: "/archives/lwt/9.9.9/lwt-9.9.9.tar.gz",
      },
      new Request("https://registry.test/archives/lwt/9.9.9/lwt-9.9.9.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("archive with an invalid name throws NAME_INVALID", async () => {
    const ctx = opamContext();
    await expect(
      new OpamAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/archives/:name/:version/:filename",
            handlerId: "archive",
          },
          params: { name: "bad.name", version: "5.6.1", filename: "x.tar.gz" },
          path: "/archives/bad.name/5.6.1/x.tar.gz",
        },
        new Request("https://registry.test/archives/bad.name/5.6.1/x.tar.gz"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("scan.referencedDigests surfaces the stored blob digest for scanning", () => {
    const scan = new OpamAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta() })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ name: "lwt", version: "1.0.0" })).toEqual([]);
  });

  test("PUT /upload publishes the archive and stores derived metadata", async () => {
    const ctx = opamContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const body = buildMultipartBody("BOUND", [
      {
        name: "manifest",
        data: new TextEncoder().encode(
          JSON.stringify({
            name: "lwt",
            version: "5.6.1",
            synopsis: "Promises and concurrency",
            depends: [{ name: "ocaml", constraint: '>= "4.08"' }],
          }),
        ),
      },
      { name: "archive", filename: "lwt-5.6.1.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await new OpamAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/upload", handlerId: "publish" },
        params: {},
        path: "/upload",
      },
      new Request("https://registry.test/upload", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, name: "lwt", version: "5.6.1" });
    expect(committed.scan).toEqual({
      name: "lwt",
      version: "5.6.1",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      name: "lwt",
      version: "5.6.1",
      synopsis: "Promises and concurrency",
      blobDigest: DIGEST,
      sha256: HEX,
      filename: "lwt-5.6.1.tar.gz",
    });
  });

  test("PUT /upload returns 409 when the version already exists", async () => {
    const ctx = opamContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      {
        name: "manifest",
        data: new TextEncoder().encode(JSON.stringify({ name: "lwt", version: "5.6.1" })),
      },
      { name: "archive", filename: "lwt-5.6.1.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await new OpamAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/upload", handlerId: "publish" },
        params: {},
        path: "/upload",
      },
      new Request("https://registry.test/upload", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("PUT /upload rejects a non-multipart body with 400", async () => {
    const ctx = opamContext();
    const res = await new OpamAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/upload", handlerId: "publish" },
        params: {},
        path: "/upload",
      },
      new Request("https://registry.test/upload", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("publish 400s when the multipart body is missing the manifest part", async () => {
    const ctx = opamContext();
    const body = buildMultipartBody("BOUND", [
      { name: "archive", filename: "lwt-5.6.1.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const res = await publishUpload(ctx, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing 'manifest' part" });
  });

  test("publish 400s when the multipart body is missing the archive part", async () => {
    const ctx = opamContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "manifest",
        data: new TextEncoder().encode(JSON.stringify({ name: "lwt", version: "5.6.1" })),
      },
    ]);
    const res = await publishUpload(ctx, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing 'archive' part" });
  });

  test("publish 400s when the manifest part is not valid JSON", async () => {
    const ctx = opamContext();
    const body = buildMultipartBody("BOUND", [
      { name: "manifest", data: new TextEncoder().encode("{ not json") },
      { name: "archive", filename: "lwt-5.6.1.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const res = await publishUpload(ctx, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "'manifest' part is not valid JSON" });
  });

  test("publish rejects a traversal archive filename with 400 NAME_INVALID", async () => {
    const ctx = opamContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "manifest",
        data: new TextEncoder().encode(JSON.stringify({ name: "lwt", version: "5.6.1" })),
      },
      { name: "archive", filename: "../evil.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    // A bad uploaded filename throws a RegistryError out of the publish parser
    // (dispatch catches it); the adapter call surfaces it as a 400/NAME_INVALID.
    await expect(publishUpload(ctx, body)).rejects.toMatchObject({
      status: 400,
      code: "NAME_INVALID",
    });
  });

  test("publish 400s when the archive filename has an unsupported extension", async () => {
    const ctx = opamContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "manifest",
        data: new TextEncoder().encode(JSON.stringify({ name: "lwt", version: "5.6.1" })),
      },
      { name: "archive", filename: "evil.exe", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    await expect(publishUpload(ctx, body)).rejects.toMatchObject({
      status: 400,
      code: "NAME_INVALID",
    });
  });

  test("opam update round-trip: published checksum matches the downloaded archive bytes", async () => {
    // The integrity property a real opam client enforces: the `checksum` embedded
    // in the opam file (read from index.tar.gz) is the sha256 of the actual bytes
    // served at `url.src`. Exercise it end-to-end with a real content-addressed
    // store: publish a real archive, read the generated index, download the
    // archive, and assert sha256(downloaded) === the embedded checksum.
    const ctx = opamContext();
    const archive = new Uint8Array(256);
    for (let i = 0; i < archive.length; i++) archive[i] = (i * 31 + 7) & 0xff;

    // Minimal in-memory CAS shared across publish + the index/archive reads.
    const blobs = new Map<string, Uint8Array>();
    let committed: Record<string, unknown> | undefined;

    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.packages.findByName = async (name) => (name === "lwt" ? pkgRow("lwt") : null);
    ctx.data.packages.list = async () => [pkgRow("lwt")];
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      const digest = computeDigest(input.data);
      blobs.set(digest, input.data);
      return { digest, size: input.data.length, deduped: false, refCreated: true, blobRefId: "r1" };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed = input.metadata;
      return { versionId: "ver_1" };
    };
    const findCommitted = async () =>
      committed ? versionRow(committed as Record<string, unknown>) : null;
    ctx.data.versions.findLive = findCommitted;
    ctx.data.versions.listLiveForPackages = async (pkgs) =>
      new Map(pkgs.map((pkg) => [pkg.id, committed ? [versionRow(committed)] : []]));
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      const bytes = blobs.get(digest);
      if (!bytes) return new Response("Not Found", { status: 404 });
      return new Response(bytes, { headers: { "content-type": contentType } });
    };

    const adapter = new OpamAdapter();

    // 1. Publish a real archive.
    const publishBody = buildMultipartBody("BOUND", [
      {
        name: "manifest",
        data: new TextEncoder().encode(JSON.stringify({ name: "lwt", version: "5.6.1" })),
      },
      { name: "archive", filename: "lwt-5.6.1.tar.gz", data: archive },
    ]);
    const publishRes = await publishUpload(ctx, publishBody, adapter);
    expect(publishRes.status).toBe(201);

    // 2. Fetch index.tar.gz, gunzip, parse the opam file, extract the sha256 hex.
    const indexRes = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/index.tar.gz", handlerId: "index" },
        params: {},
        path: "/index.tar.gz",
      },
      new Request("https://registry.test/index.tar.gz"),
      ctx,
    );
    expect(indexRes.status).toBe(200);
    const tar = decodeTar(Bun.gunzipSync(new Uint8Array(await indexRes.arrayBuffer())));
    const opamFile = tar.get("packages/lwt/lwt.5.6.1/opam");
    expect(opamFile).toBeTruthy();
    const checksumMatch = opamFile?.match(/checksum: \[ "sha256=([a-f0-9]{64})" \]/);
    const embeddedHex = checksumMatch?.[1];
    if (!embeddedHex) throw new Error("expected a sha256 checksum in the opam file");
    // The published checksum must equal the sha256 of the bytes we actually stored.
    expect(embeddedHex).toBe(computeDigest(archive).slice("sha256:".length));

    // 3. Download the archive via /archives/... and verify the bytes hash to it.
    const archiveRes = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/archives/:name/:version/:filename",
          handlerId: "archive",
        },
        params: { name: "lwt", version: "5.6.1", filename: "lwt-5.6.1.tar.gz" },
        path: "/archives/lwt/5.6.1/lwt-5.6.1.tar.gz",
      },
      new Request("https://registry.test/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"),
      ctx,
    );
    expect(archiveRes.status).toBe(200);
    const downloaded = new Uint8Array(await archiveRes.arrayBuffer());
    expect(Array.from(downloaded)).toEqual(Array.from(archive));
    expect(computeDigest(downloaded).slice("sha256:".length)).toBe(embeddedHex);
  });
});

function publishUpload(
  ctx: ReturnType<typeof opamContext>,
  body: Uint8Array,
  adapter = new OpamAdapter(),
): Promise<Response> {
  return adapter.handle(
    {
      entry: { method: "PUT", pattern: "/upload", handlerId: "publish" },
      params: {},
      path: "/upload",
    },
    new Request("https://registry.test/upload", {
      method: "PUT",
      headers: { "content-type": "multipart/form-data; boundary=BOUND" },
      body,
    }),
    ctx,
  );
}
