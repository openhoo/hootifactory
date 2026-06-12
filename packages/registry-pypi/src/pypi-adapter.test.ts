import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { PypiAdapter, pypiRegistryPlugin } from "./pypi-adapter";
import { SIMPLE_JSON_CONTENT_TYPE } from "./simple";

const downloadMatch = {
  entry: { method: "GET", pattern: "/files/:filename", handlerId: "download" },
  params: { filename: "demo_pkg-1.0.0-py3-none-any.whl" },
  path: "/files/demo_pkg-1.0.0-py3-none-any.whl",
} satisfies RouteMatch;

function assetRow(overrides: Partial<RegistryAssetRow> = {}): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: pkg.id,
    packageVersionId: "ver_1",
    blobRefId: "blob_ref_1",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    role: "pypi_file",
    scope: "demo_pkg-1.0.0-py3-none-any.whl",
    path: "demo_pkg-1.0.0-py3-none-any.whl",
    mediaType: "application/octet-stream",
    sizeBytes: 7,
    metadata: { filetype: "bdist_wheel" },
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

const simpleRootMatch = {
  entry: { method: "GET", pattern: "/simple/", handlerId: "simpleRoot" },
  params: {},
  path: "/simple/",
} satisfies RouteMatch;

const simpleProjectMatch = {
  entry: { method: "GET", pattern: "/simple/:project/", handlerId: "simpleProject" },
  params: { project: "Demo_Pkg" },
  path: "/simple/Demo_Pkg/",
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "demo-pkg",
  namespace: null,
  metadata: {},
  latestVersion: "1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function versionRow(metadata: unknown): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: pkg.id,
    version: "1.0.0",
    metadata,
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

describe("PyPI adapter", () => {
  test("simple root index emits an ETag and honors If-None-Match", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "pypi", mountPath: "pypi/private" };
    let listReads = 0;
    ctx.data.packages.listNames = async () => {
      listReads += 1;
      return [{ name: "demo-pkg" }];
    };

    const adapter = new PypiAdapter();
    const first = await adapter.handle(
      simpleRootMatch,
      new Request("https://registry.test/simple/"),
      ctx,
    );
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(first.text()).resolves.toContain("demo-pkg");
    expect(listReads).toBe(1);

    const cached = await adapter.handle(
      simpleRootMatch,
      new Request("https://registry.test/simple/", { headers: { "if-none-match": etag } }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
    expect(listReads).toBe(1);
  });

  test("simple project JSON emits an ETag and honors If-None-Match", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "pypi", mountPath: "pypi/private" };
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.versions.listLive = async (row) => {
      expect(row.id).toBe(pkg.id);
      return [
        versionRow({
          files: [
            {
              filename: "demo_pkg-1.0.0-py3-none-any.whl",
              blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              size: 7,
            },
          ],
        }),
      ];
    };

    const adapter = new PypiAdapter();
    const first = await adapter.handle(
      simpleProjectMatch,
      new Request("https://registry.test/simple/Demo_Pkg/", {
        headers: { accept: SIMPLE_JSON_CONTENT_TYPE },
      }),
      ctx,
    );
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe(SIMPLE_JSON_CONTENT_TYPE);
    await expect(first.json()).resolves.toMatchObject({
      name: "demo-pkg",
      versions: ["1.0.0"],
      files: [{ filename: "demo_pkg-1.0.0-py3-none-any.whl" }],
    });

    const cached = await adapter.handle(
      simpleProjectMatch,
      new Request("https://registry.test/simple/Demo_Pkg/", {
        headers: { accept: SIMPLE_JSON_CONTENT_TYPE, "if-none-match": etag },
      }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });

  test("simple root redirects a path without the trailing slash", async () => {
    const ctx = createTestRegistryContext();
    const adapter = new PypiAdapter();

    const res = await adapter.handle(
      simpleRootMatch,
      new Request("https://registry.test/simple"),
      ctx,
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://registry.test/simple/");
  });

  test("simple project returns 404 when the package is unknown", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "pypi", mountPath: "pypi/private" };
    ctx.data.packages.findByName = async () => null;

    await expect(
      new PypiAdapter().handle(
        simpleProjectMatch,
        new Request("https://registry.test/simple/Demo_Pkg/"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("simple project renders HTML links for live releases", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "pypi", mountPath: "pypi/private", id: "repo_1" };
    ctx.baseUrl = "https://registry.test";
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow({
        files: [
          {
            filename: "demo_pkg-1.0.0-py3-none-any.whl",
            blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            size: 7,
          },
        ],
      }),
    ];

    const res = await new PypiAdapter().handle(
      simpleProjectMatch,
      new Request("https://registry.test/simple/Demo_Pkg/"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(res.text()).resolves.toContain("demo_pkg-1.0.0-py3-none-any.whl");
  });

  test("download serves the stored blob for an existing distribution", async () => {
    const ctx = createTestRegistryContext();
    const served: { digest?: string } = {};
    ctx.data.assets.findByScope = async (input) => {
      expect(input).toMatchObject({ role: "pypi_file", scope: "demo_pkg-1.0.0-py3-none-any.whl" });
      return assetRow();
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("wheel-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new PypiAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/files/demo_pkg-1.0.0-py3-none-any.whl"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(served.digest).toBe(assetRow().digest);
    await expect(res.text()).resolves.toBe("wheel-bytes");
  });

  test("download returns 404 when the distribution file is unknown", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async () => null;

    await expect(
      new PypiAdapter().handle(
        downloadMatch,
        new Request("https://registry.test/files/demo_pkg-1.0.0-py3-none-any.whl"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("download rejects an unsafe distribution filename", async () => {
    const ctx = createTestRegistryContext();

    await expect(
      new PypiAdapter().handle(
        {
          entry: { method: "GET", pattern: "/files/:filename", handlerId: "download" },
          params: { filename: "../escape.whl" },
          path: "/files/../escape.whl",
        },
        new Request("https://registry.test/files/..%2Fescape.whl"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("upload clears the cached simple root index on success", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "pypi", mountPath: "pypi/private", id: "repo_1" };
    let listReads = 0;
    ctx.data.packages.listNames = async () => {
      listReads += 1;
      return [{ name: "demo-pkg" }];
    };
    ctx.data.assets.findByScope = async () => null;
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.content.storeBlobStreamWithRef = async () => ({
      digest: `sha256:${"a".repeat(64)}`,
      size: 11,
      deduped: false,
      refCreated: true,
      blobRefId: "blob_ref_1",
    });
    ctx.data.versions.create = async () => "version_1";
    ctx.data.assets.upsert = async () => assetRow();

    const adapter = new PypiAdapter();
    // Warm the simple-root cache.
    await adapter.handle(simpleRootMatch, new Request("https://registry.test/simple/"), ctx);
    expect(listReads).toBe(1);
    // Second read is served from cache.
    await adapter.handle(simpleRootMatch, new Request("https://registry.test/simple/"), ctx);
    expect(listReads).toBe(1);

    const form = new FormData();
    form.set("name", "demo-pkg");
    form.set("version", "1.2.3");
    form.set("sha256_digest", "a".repeat(64));
    form.set(
      "content",
      new File([new TextEncoder().encode("wheel-bytes")], "demo_pkg-1.2.3-py3-none-any.whl"),
    );
    const upload = await adapter.handle(
      {
        entry: { method: "POST", pattern: "/legacy/", handlerId: "upload" },
        params: {},
        path: "/legacy/",
      },
      new Request("https://registry.test/legacy/", { method: "POST", body: form }),
      ctx,
    );
    expect(upload.status).toBe(200);

    // Cache was invalidated, so the next read recomputes from the data layer.
    await adapter.handle(simpleRootMatch, new Request("https://registry.test/simple/"), ctx);
    expect(listReads).toBe(2);
  });

  test("requiredPermission scopes by artifact, package, or repo", () => {
    const adapter = new PypiAdapter();
    const ctx = createTestRegistryContext();

    expect(
      adapter.requiredPermission(
        "GET",
        {
          entry: { method: "GET", pattern: "/files/:filename", handlerId: "download" },
          params: { filename: "demo_pkg-1.0.0-py3-none-any.whl" },
          path: "/files/demo_pkg-1.0.0-py3-none-any.whl",
        },
        ctx,
      ),
    ).toMatchObject({
      action: "read",
      resource: { type: "artifact", artifactRef: "demo_pkg-1.0.0-py3-none-any.whl" },
    });

    expect(adapter.requiredPermission("GET", simpleProjectMatch, ctx)).toMatchObject({
      action: "read",
      resource: { type: "package", packageName: "demo-pkg" },
    });

    expect(adapter.requiredPermission("POST", simpleRootMatch, ctx)).toMatchObject({
      action: "write",
    });
  });

  test("scan config references PyPI ecosystem and stored file digests", () => {
    const adapter = new PypiAdapter();

    expect(adapter.scan?.defaultOsvEcosystem).toBe("PyPI");
    expect(
      adapter.scan?.referencedDigests?.({
        files: [
          { blobDigest: "sha256:a" },
          { blobDigest: 123 },
          null,
          { filename: "no-digest.whl" },
        ],
      }),
    ).toEqual(["sha256:a"]);
    expect(adapter.scan?.referencedDigests?.({ files: "not-an-array" })).toEqual([]);
  });

  test("exports a registry plugin instance", () => {
    expect(pypiRegistryPlugin).toBeInstanceOf(PypiAdapter);
  });
});
