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
  test("declares repodata, repodataBz2, download, and publish routes in order", () => {
    expect(new CondaAdapter().routes()).toEqual([
      {
        method: "GET",
        pattern: "/:subdir/repodata.json",
        handlerId: "repodata",
        proxyRefreshTrigger: true,
        metadataMergeable: true,
        packageParam: "subdir",
      },
      { method: "GET", pattern: "/:subdir/repodata.json.bz2", handlerId: "repodataBz2" },
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

  test("GET /<subdir>/repodata.json.bz2 returns a gzip-compressed variant", async () => {
    const ctx = condaContext();
    ctx.data.packages.listNames = async () => [{ name: "numpy" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new CondaAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:subdir/repodata.json.bz2", handlerId: "repodataBz2" },
        params: { subdir: "linux-64" },
        path: "/linux-64/repodata.json.bz2",
      },
      new Request("https://registry.test/linux-64/repodata.json.bz2"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const gz = new Uint8Array(await res.arrayBuffer());
    const json = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz)));
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
    const res = await new CondaAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
        params: { subdir: "linux-64", filename: "other-1.0-0.conda" },
        path: "/linux-64/other-1.0-0.conda",
      },
      new Request("https://registry.test/linux-64/other-1.0-0.conda"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download 404s when the stored metadata is for a different subdir", async () => {
    const ctx = condaContext();
    ctx.data.packages.findByName = async () => pkgRow("numpy");
    // storedMeta has subdir "linux-64"; request a noarch path for the same file.
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    const res = await new CondaAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:subdir/:filename", handlerId: "download" },
        params: { subdir: "noarch", filename: "numpy-1.21.0-py39_0.conda" },
        path: "/noarch/numpy-1.21.0-py39_0.conda",
      },
      new Request("https://registry.test/noarch/numpy-1.21.0-py39_0.conda"),
      ctx,
    );
    expect(res.status).toBe(404);
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
        data: new Uint8Array([1, 2, 3, 4]),
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
        data: new Uint8Array([1, 2, 3, 4]),
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
