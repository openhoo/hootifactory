import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { CondaAdapter } from "./conda-adapter";
import { buildCondaVersionMeta, CondaIndexJsonSchema } from "./conda-validation";
import { buildMultipartBody } from "./conda-validation.test";

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
    latestVersion: "1.0.0",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  metadata: Record<string, unknown>,
  version = "1.0.0",
): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_numpy",
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

const storedMeta = buildCondaVersionMeta(
  CondaIndexJsonSchema.parse({
    name: "numpy",
    version: "1.21.0",
    build: "py39_0",
    build_number: 0,
    depends: ["python >=3.9"],
    license: "BSD-3-Clause",
  }),
  {
    subdir: "linux-64",
    filename: "numpy-1.21.0-py39_0.conda",
    packageKind: "conda",
    digest: DIGEST,
    sha256: HEX,
    md5: "b".repeat(32),
    size: 4,
  },
);

function condaContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "conda", mountPath: "conda/private" };
  return ctx;
}

describe("Conda adapter", () => {
  test("declares repodata, repodataZst, download, and publish routes in order", () => {
    expect(new CondaAdapter().routes()).toEqual([
      {
        method: "GET",
        pattern: "/:subdir/repodata.json",
        handlerId: "repodata",
        proxyRefreshTrigger: true,
        metadataMergeable: true,
        packageParam: "subdir",
      },
      {
        method: "GET",
        pattern: "/:subdir/repodata.json.zst",
        handlerId: "repodataZst",
        proxyRefreshTrigger: true,
        packageParam: "subdir",
      },
      { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
      { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
    ]);
  });

  test("declares proxyable + virtualizable capabilities and exposes proxy/virtual hooks", () => {
    const adapter = new CondaAdapter();
    expect(adapter.capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
    expect(typeof adapter.proxyIngest).toBe("function");
    expect(typeof adapter.generateMetadata).toBe("function");
    expect(typeof adapter.mergeMetadata).toBe("function");
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new CondaAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the subdir/filename artifact ref", () => {
    const adapter = new CondaAdapter();
    const match = {
      entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
      params: { subdir: "linux-64", filename: "numpy-1.21.0-py39_0.conda" },
      path: "/linux-64/numpy-1.21.0-py39_0.conda",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "linux-64/numpy-1.21.0-py39_0.conda" },
    });
  });

  test("GET /<subdir>/repodata.json builds the channel index, cacheable via ETag", async () => {
    const ctx = condaContext();
    ctx.data.packages.listNames = async () => [{ name: "numpy" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const adapter = new CondaAdapter();
    const res = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/:subdir/repodata.json",
          handlerId: "repodata",
          packageParam: "subdir",
        },
        params: { subdir: "linux-64" },
        path: "/linux-64/repodata.json",
      },
      new Request("https://registry.test/linux-64/repodata.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      info: { subdir: string };
      packages: Record<string, unknown>;
      "packages.conda": Record<string, Record<string, unknown>>;
    };
    expect(body.info).toEqual({ subdir: "linux-64" });
    expect(body.packages).toEqual({});
    expect(body["packages.conda"]["numpy-1.21.0-py39_0.conda"]).toMatchObject({
      name: "numpy",
      version: "1.21.0",
      build: "py39_0",
      subdir: "linux-64",
      sha256: HEX,
      depends: ["python >=3.9"],
    });

    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    const cached = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/:subdir/repodata.json",
          handlerId: "repodata",
          packageParam: "subdir",
        },
        params: { subdir: "linux-64" },
        path: "/linux-64/repodata.json",
      },
      new Request("https://registry.test/linux-64/repodata.json", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /<subdir>/repodata.json.zst returns a zstd-compressed variant", async () => {
    const ctx = condaContext();
    ctx.data.packages.listNames = async () => [{ name: "numpy" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new CondaAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:subdir/repodata.json.zst", handlerId: "repodataZst" },
        params: { subdir: "linux-64" },
        path: "/linux-64/repodata.json.zst",
      },
      new Request("https://registry.test/linux-64/repodata.json.zst"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zstd");
    const compressed = new Uint8Array(await res.arrayBuffer());
    const json = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(compressed)));
    expect(json.info).toEqual({ subdir: "linux-64" });
  });

  test("download resolves the stored blob digest for the matching filename", async () => {
    const ctx = condaContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("numpy");
      return pkgRow("numpy");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      // The version key embeds version-build-kind.
      expect(version).toBe("1.21.0-py39_0-conda");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("blob-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new CondaAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
        params: { subdir: "linux-64", filename: "numpy-1.21.0-py39_0.conda" },
        path: "/linux-64/numpy-1.21.0-py39_0.conda",
      },
      new Request("https://registry.test/linux-64/numpy-1.21.0-py39_0.conda"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("blob-bytes");
  });

  test("download 404s when the filename is unknown in the subdir", async () => {
    const ctx = condaContext();
    ctx.data.packages.findByName = async () => pkgRow("other");
    ctx.data.versions.findLive = async () => null;
    await expect(
      new CondaAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
          params: { subdir: "linux-64", filename: "other-1.0-0.conda" },
          path: "/linux-64/other-1.0-0.conda",
        },
        new Request("https://registry.test/linux-64/other-1.0-0.conda"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("download 404s when the stored metadata is for a different subdir", async () => {
    const ctx = condaContext();
    ctx.data.packages.findByName = async () => pkgRow("numpy");
    // storedMeta has subdir "linux-64"; request a noarch path for the same file.
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    await expect(
      new CondaAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
          params: { subdir: "noarch", filename: "numpy-1.21.0-py39_0.conda" },
          path: "/noarch/numpy-1.21.0-py39_0.conda",
        },
        new Request("https://registry.test/noarch/numpy-1.21.0-py39_0.conda"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("GET /<subdir>/<index-variant> 404s (not 400) so conda falls back to repodata.json", async () => {
    // Stock conda probes `current_repodata.json{,.zst}` and `repodata.json.bz2`
    // FIRST through the `/:subdir/:filename` route and only falls back to the
    // working `repodata.json` on a 404 — a 400 would surface as a hard
    // CondaHTTPError. These filenames are not package files, so the download
    // handler must answer 404, not 400.
    const adapter = new CondaAdapter();
    for (const filename of [
      "current_repodata.json",
      "current_repodata.json.zst",
      "repodata.json.bz2",
    ]) {
      const ctx = condaContext();
      await expect(
        adapter.handle(
          {
            entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
            params: { subdir: "linux-64", filename },
            path: `/linux-64/${filename}`,
          },
          new Request(`https://registry.test/linux-64/${filename}`),
          ctx,
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  });

  test("download with an invalid subdir throws NAME_INVALID", async () => {
    const ctx = condaContext();
    await expect(
      new CondaAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
          params: { subdir: "bad/sub", filename: "a-1-0.conda" },
          path: "/bad%2Fsub/a-1-0.conda",
        },
        new Request("https://registry.test/bad%2Fsub/a-1-0.conda"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("PUT /<subdir>/<filename> publishes the package and stores derived metadata", async () => {
    const ctx = condaContext();
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
        name: "index",
        data: new TextEncoder().encode(
          JSON.stringify({
            name: "numpy",
            version: "1.21.0",
            build: "py39_0",
            build_number: 0,
            depends: ["python >=3.9"],
            subdir: "linux-64",
          }),
        ),
      },
      {
        name: "artifact",
        filename: "numpy-1.21.0-py39_0.conda",
        // `.conda` is a zip: lead with the ZIP local-file magic (PK\x03\x04).
        data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      },
    ]);

    const res = await new CondaAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename: "numpy-1.21.0-py39_0.conda" },
        path: "/linux-64/numpy-1.21.0-py39_0.conda",
      },
      new Request("https://registry.test/linux-64/numpy-1.21.0-py39_0.conda", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      name: "numpy",
      version: "1.21.0",
      subdir: "linux-64",
      filename: "numpy-1.21.0-py39_0.conda",
    });
    expect(committed.scan).toEqual({
      name: "numpy",
      version: "1.21.0",
      mediaType: "application/octet-stream",
    });
    expect(committed.metadata).toMatchObject({
      subdir: "linux-64",
      filename: "numpy-1.21.0-py39_0.conda",
      packageKind: "conda",
      blobDigest: DIGEST,
      sha256: HEX,
    });
  });

  test("PUT rejects an artifact filename that disagrees with the URL path", async () => {
    const ctx = condaContext();
    // The uploaded part is named `evil-...`, but the URL (and permission scope)
    // targets `numpy-...`; storing the mismatched filename must be rejected.
    const body = buildMultipartBody("BOUND", [
      {
        name: "index",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "evil", version: "1.0.0", build: "0" }),
        ),
      },
      { name: "artifact", filename: "evil-1.0.0-0.conda", data: new Uint8Array([1, 2]) },
    ]);
    const res = await new CondaAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename: "numpy-1.21.0-py39_0.conda" },
        path: "/linux-64/numpy-1.21.0-py39_0.conda",
      },
      new Request("https://registry.test/linux-64/numpy-1.21.0-py39_0.conda", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "artifact filename does not match the upload path",
    });
  });

  test("PUT rejects a filename that disagrees with the index name/version/build", async () => {
    const ctx = condaContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "index",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "numpy", version: "1.21.0", build: "py39_0" }),
        ),
      },
      { name: "artifact", filename: "numpy-9.9.9-other_0.conda", data: new Uint8Array([1, 2]) },
    ]);
    const res = await new CondaAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename: "numpy-9.9.9-other_0.conda" },
        path: "/linux-64/numpy-9.9.9-other_0.conda",
      },
      new Request("https://registry.test/linux-64/numpy-9.9.9-other_0.conda", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("PUT returns 409 when the package version already exists", async () => {
    const ctx = condaContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      {
        name: "index",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "numpy", version: "1.21.0", build: "py39_0" }),
        ),
      },
      {
        name: "artifact",
        filename: "numpy-1.21.0-py39_0.conda",
        // `.conda` is a zip: lead with the ZIP local-file magic (PK\x03\x04).
        data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      },
    ]);

    const res = await new CondaAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename: "numpy-1.21.0-py39_0.conda" },
        path: "/linux-64/numpy-1.21.0-py39_0.conda",
      },
      new Request("https://registry.test/linux-64/numpy-1.21.0-py39_0.conda", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "package already exists" });
  });

  test("PUT rejects a non-multipart body with 400", async () => {
    const ctx = condaContext();
    const res = await new CondaAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename: "a-1-0.conda" },
        path: "/linux-64/a-1-0.conda",
      },
      new Request("https://registry.test/linux-64/a-1-0.conda", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("PUT rejects an artifact whose bytes are not the declared archive format", async () => {
    const ctx = condaContext();
    let committed = false;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.versions.commitOrReleaseBlob = async () => {
      committed = true;
      return { versionId: "ver_1" };
    };
    // A `.conda` file must be a zip (PK\x03\x04); these bytes are not, so the
    // blob must be refused before it is stored/indexed as a real package.
    const body = buildMultipartBody("BOUND", [
      {
        name: "index",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "numpy", version: "1.21.0", build: "py39_0" }),
        ),
      },
      {
        name: "artifact",
        filename: "numpy-1.21.0-py39_0.conda",
        data: new TextEncoder().encode("not a zip"),
      },
    ]);
    const res = await new CondaAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename: "numpy-1.21.0-py39_0.conda" },
        path: "/linux-64/numpy-1.21.0-py39_0.conda",
      },
      new Request("https://registry.test/linux-64/numpy-1.21.0-py39_0.conda", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "artifact is not a valid Conda package archive",
    });
    expect(committed).toBe(false);
  });

  test("publish -> repodata.json{,.zst} -> download round-trips bytes and checksums", async () => {
    // A package-level round-trip over a shared in-memory data fake: PUT a real
    // (zip-magic) `.conda`, then read the regenerated `repodata.json` and its
    // `.zst` variant and assert the advertised sha256/md5/size, then download
    // the blob and assert the served bytes hash back to that sha256/md5. This
    // locks the publish <-> index <-> download contract end to end.
    const artifactBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x09, 0x08, 0x07]);
    const expectedSha256 = new Bun.CryptoHasher("sha256").update(artifactBytes).digest("hex");
    const expectedMd5 = new Bun.CryptoHasher("md5").update(artifactBytes).digest("hex");
    const digest = `sha256:${expectedSha256}`;

    // Shared store: capture the version committed by publish, replay it to reads.
    const store: { pkg?: RegistryPackageRow; version?: RegistryPackageVersionRow } = {};
    const ctx = condaContext();
    ctx.data.packages.findByName = async (name) =>
      store.pkg && store.pkg.name === name ? store.pkg : null;
    ctx.data.packages.findOrCreate = async ({ name }) => {
      store.pkg = pkgRow(name);
      return store.pkg;
    };
    ctx.data.packages.listNames = async () => (store.pkg ? [{ name: store.pkg.name }] : []);
    ctx.data.versions.exists = async () => Boolean(store.version);
    ctx.data.versions.listLive = async () => (store.version ? [store.version] : []);
    ctx.data.versions.findLive = async () => store.version ?? null;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest,
      size: artifactBytes.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      store.version = versionRow(input.metadata);
      return { versionId: "ver_1" };
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ contentType }) =>
      new Response(artifactBytes, { headers: { "content-type": contentType } });

    const adapter = new CondaAdapter();
    const filename = "numpy-1.21.0-py39_0.conda";

    const publishBody = buildMultipartBody("BOUND", [
      {
        name: "index",
        data: new TextEncoder().encode(
          JSON.stringify({
            name: "numpy",
            version: "1.21.0",
            build: "py39_0",
            build_number: 0,
            depends: ["python >=3.9"],
            subdir: "linux-64",
          }),
        ),
      },
      { name: "artifact", filename, data: artifactBytes },
    ]);
    const published = await adapter.handle(
      {
        entry: { method: "PUT", pattern: "/:subdir/:filename", handlerId: "publish" },
        params: { subdir: "linux-64", filename },
        path: `/linux-64/${filename}`,
      },
      new Request(`https://registry.test/linux-64/${filename}`, {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: publishBody,
      }),
      ctx,
    );
    expect(published.status).toBe(201);

    // repodata.json reflects the published package with the real checksums.
    const repodataRes = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/:subdir/repodata.json",
          handlerId: "repodata",
          packageParam: "subdir",
        },
        params: { subdir: "linux-64" },
        path: "/linux-64/repodata.json",
      },
      new Request("https://registry.test/linux-64/repodata.json"),
      ctx,
    );
    expect(repodataRes.status).toBe(200);
    const repodata = (await repodataRes.json()) as {
      "packages.conda": Record<string, { sha256: string; md5: string; size: number }>;
    };
    const record = repodata["packages.conda"][filename];
    if (!record) throw new Error("expected the published package in repodata");
    expect(record).toMatchObject({
      sha256: expectedSha256,
      md5: expectedMd5,
      size: artifactBytes.length,
    });

    // The `.zst` variant decodes to the same index (and is real zstd).
    const zstRes = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/:subdir/repodata.json.zst",
          handlerId: "repodataZst",
          proxyRefreshTrigger: true,
          packageParam: "subdir",
        },
        params: { subdir: "linux-64" },
        path: "/linux-64/repodata.json.zst",
      },
      new Request("https://registry.test/linux-64/repodata.json.zst"),
      ctx,
    );
    expect(zstRes.status).toBe(200);
    expect(zstRes.headers.get("content-type")).toBe("application/zstd");
    const decoded = JSON.parse(
      new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await zstRes.arrayBuffer()))),
    );
    expect(decoded["packages.conda"][filename]).toMatchObject({ sha256: expectedSha256 });

    // The download serves bytes that hash back to the advertised checksums.
    const downloadRes = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
        params: { subdir: "linux-64", filename },
        path: `/linux-64/${filename}`,
      },
      new Request(`https://registry.test/linux-64/${filename}`),
      ctx,
    );
    expect(downloadRes.status).toBe(200);
    const servedBytes = new Uint8Array(await downloadRes.arrayBuffer());
    expect(new Bun.CryptoHasher("sha256").update(servedBytes).digest("hex")).toBe(record.sha256);
    expect(new Bun.CryptoHasher("md5").update(servedBytes).digest("hex")).toBe(record.md5);
  });

  test("generateMetadata produces a subdir repodata document", async () => {
    const ctx = condaContext();
    ctx.data.packages.listNames = async () => [{ name: "numpy" }];
    ctx.data.packages.findByName = async () => pkgRow("numpy");
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];
    const adapter = new CondaAdapter();
    const part = await adapter.generateMetadata?.("linux-64", ctx);
    expect(part).not.toBeNull();
    const doc = JSON.parse(part?.body as string);
    expect(doc.info).toEqual({ subdir: "linux-64" });
    expect(Object.keys(doc["packages.conda"])).toEqual(["numpy-1.21.0-py39_0.conda"]);
  });

  test("mergeMetadata folds member repodata documents into one", async () => {
    const ctx = condaContext();
    const adapter = new CondaAdapter();
    const memberA = {
      contentType: "application/json",
      body: JSON.stringify({
        info: { subdir: "linux-64" },
        packages: {},
        "packages.conda": { "a-1-0.conda": { name: "a", version: "1", build: "0" } },
        repodata_version: 1,
        removed: [],
      }),
    };
    const memberB = {
      contentType: "application/json",
      body: JSON.stringify({
        info: { subdir: "linux-64" },
        packages: { "b-1-0.tar.bz2": { name: "b", version: "1", build: "0" } },
        "packages.conda": {},
        repodata_version: 1,
        removed: [],
      }),
    };
    const merged = await adapter.mergeMetadata?.([memberA, memberB], ctx);
    const doc = JSON.parse(merged?.body as string);
    expect(Object.keys(doc["packages.conda"])).toEqual(["a-1-0.conda"]);
    expect(Object.keys(doc.packages)).toEqual(["b-1-0.tar.bz2"]);
  });

  test("scan.referencedDigests surfaces the stored blob digest for scanning", () => {
    const scan = new CondaAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ subdir: "linux-64" })).toEqual([]);
  });
});
