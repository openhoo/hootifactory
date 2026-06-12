import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { ScoopAdapter } from "./scoop-adapter";
import { buildScoopVersionMeta, ScoopPublishManifestSchema } from "./scoop-validation";
import { buildMultipartBody } from "./scoop-validation.test";

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
    latestVersion: "1.2.3",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  metadata: Record<string, unknown>,
  version = "1.2.3",
): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_demo",
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

const storedMeta = buildScoopVersionMeta(
  ScoopPublishManifestSchema.parse({
    version: "1.2.3",
    description: "demo app",
    bin: "demo.exe",
  }),
  { digest: DIGEST, sha256: HEX, filename: "demo-1.2.3.zip" },
);

function scoopContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "scoop", mountPath: "scoop/private" };
  return ctx;
}

describe("Scoop adapter", () => {
  test("declares index, download, manifest, and publish routes (index before :app)", () => {
    expect(new ScoopAdapter().routes()).toEqual([
      { method: "GET", pattern: "/index.json", handlerId: "index" },
      {
        method: "GET",
        pattern: "/download/:app/:version/:filename",
        handlerId: "download",
      },
      { method: "GET", pattern: "/:app", handlerId: "manifest" },
      { method: "PUT", pattern: "/:app", handlerId: "publish" },
    ]);
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new ScoopAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the artifact ref", () => {
    const adapter = new ScoopAdapter();
    const match = {
      entry: {
        method: "GET",
        pattern: "/download/:app/:version/:filename",
        handlerId: "download",
      },
      params: { app: "demo", version: "1.2.3", filename: "demo-1.2.3.zip" },
      path: "/download/demo/1.2.3/demo-1.2.3.zip",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "demo",
        artifactRef: "demo@1.2.3/demo-1.2.3.zip",
      },
    });
  });

  test("manifest permission strips the .json suffix to the package name", () => {
    const adapter = new ScoopAdapter();
    const match = {
      entry: { method: "GET", pattern: "/:app", handlerId: "manifest" },
      params: { app: "demo.json" },
      path: "/demo.json",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("GET /index.json lists apps with their latest version, ordered + cacheable", async () => {
    const ctx = scoopContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }, { name: "alpha" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (row, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow({ ...storedMeta, version: row.name === "alpha" ? "9.9.9" : "1.2.3" })];
    };

    const res = await new ScoopAdapter().handle(
      {
        entry: { method: "GET", pattern: "/index.json", handlerId: "index" },
        params: {},
        path: "/index.json",
      },
      new Request("https://registry.test/index.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    // Alphabetical ordering: alpha before demo.
    expect(await res.text()).toBe(
      JSON.stringify({ alpha: { version: "9.9.9" }, demo: { version: "1.2.3" } }),
    );

    if (!etag) throw new Error("expected ETag");
    const cached = await new ScoopAdapter().handle(
      {
        entry: { method: "GET", pattern: "/index.json", handlerId: "index" },
        params: {},
        path: "/index.json",
      },
      new Request("https://registry.test/index.json", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /<app>.json assembles the manifest with a hosted url + computed hash", async () => {
    const ctx = scoopContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkgRow("demo");
    };
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new ScoopAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:app", handlerId: "manifest" },
        params: { app: "demo.json" },
        path: "/demo.json",
      },
      new Request("https://registry.test/demo.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      version: "1.2.3",
      description: "demo app",
      bin: "demo.exe",
      url: "https://registry.example.test/scoop/private/download/demo/1.2.3/demo-1.2.3.zip",
      hash: HEX,
    });
  });

  test("GET /<app>.json 404s when the package is unknown", async () => {
    const ctx = scoopContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new ScoopAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:app", handlerId: "manifest" },
          params: { app: "missing.json" },
          path: "/missing.json",
        },
        new Request("https://registry.test/missing.json"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("download resolves the stored blob digest for the matching filename", async () => {
    const ctx = scoopContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("blob-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new ScoopAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/download/:app/:version/:filename",
          handlerId: "download",
        },
        params: { app: "demo", version: "1.2.3", filename: "demo-1.2.3.zip" },
        path: "/download/demo/1.2.3/demo-1.2.3.zip",
      },
      new Request("https://registry.test/download/demo/1.2.3/demo-1.2.3.zip"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("blob-bytes");
  });

  test("GET /<app> without a .json suffix throws notFound", async () => {
    const ctx = scoopContext();
    await expect(
      new ScoopAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:app", handlerId: "manifest" },
          params: { app: "demo" },
          path: "/demo",
        },
        new Request("https://registry.test/demo"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("GET /<app>.json with an invalid app name throws NAME_INVALID", async () => {
    const ctx = scoopContext();
    await expect(
      new ScoopAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:app", handlerId: "manifest" },
          params: { app: "bad name.json" },
          path: "/bad%20name.json",
        },
        new Request("https://registry.test/bad%20name.json"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("download with an invalid app name throws NAME_INVALID", async () => {
    const ctx = scoopContext();
    await expect(
      new ScoopAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/download/:app/:version/:filename",
            handlerId: "download",
          },
          params: { app: "bad name", version: "1.2.3", filename: "demo-1.2.3.zip" },
          path: "/download/bad%20name/1.2.3/demo-1.2.3.zip",
        },
        new Request("https://registry.test/download/bad%20name/1.2.3/demo-1.2.3.zip"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("download 404s when the version is missing or not live", async () => {
    const ctx = scoopContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    // findLive returns null for an unknown / non-live version.
    ctx.data.versions.findLive = async () => null;
    await expect(
      new ScoopAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/download/:app/:version/:filename",
            handlerId: "download",
          },
          params: { app: "demo", version: "9.9.9", filename: "demo-1.2.3.zip" },
          path: "/download/demo/9.9.9/demo-1.2.3.zip",
        },
        new Request("https://registry.test/download/demo/9.9.9/demo-1.2.3.zip"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("scan.referencedDigests surfaces the stored blob digest for scanning", () => {
    const scan = new ScoopAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    // Metadata without a blob digest references nothing.
    expect(scan?.referencedDigests?.({ version: "1.0.0" })).toEqual([]);
  });

  test("download 404s when the requested filename does not match the stored artifact", async () => {
    const ctx = scoopContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    await expect(
      new ScoopAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/download/:app/:version/:filename",
            handlerId: "download",
          },
          params: { app: "demo", version: "1.2.3", filename: "other.zip" },
          path: "/download/demo/1.2.3/other.zip",
        },
        new Request("https://registry.test/download/demo/1.2.3/other.zip"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("PUT /<app> publishes the artifact and stores derived metadata", async () => {
    const ctx = scoopContext();
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
          JSON.stringify({ version: "1.2.3", description: "demo app", bin: "demo.exe" }),
        ),
      },
      { name: "artifact", filename: "demo-1.2.3.zip", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await new ScoopAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:app", handlerId: "publish" },
        params: { app: "demo" },
        path: "/demo",
      },
      new Request("https://registry.test/demo", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, app: "demo", version: "1.2.3" });
    // The blob's sha256/digest scan is wired through the commit (not a separate enqueue).
    expect(committed.scan).toEqual({
      name: "demo",
      version: "1.2.3",
      mediaType: "application/octet-stream",
    });
    expect(committed.metadata).toMatchObject({
      version: "1.2.3",
      description: "demo app",
      bin: "demo.exe",
      blobDigest: DIGEST,
      sha256: HEX,
      filename: "demo-1.2.3.zip",
    });
  });

  test("PUT /<app> returns 409 when the version already exists", async () => {
    const ctx = scoopContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      { name: "manifest", data: new TextEncoder().encode(JSON.stringify({ version: "1.2.3" })) },
      { name: "artifact", filename: "demo-1.2.3.zip", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await new ScoopAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:app", handlerId: "publish" },
        params: { app: "demo" },
        path: "/demo",
      },
      new Request("https://registry.test/demo", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("PUT /<app> rejects a non-multipart body with 400", async () => {
    const ctx = scoopContext();
    const res = await new ScoopAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:app", handlerId: "publish" },
        params: { app: "demo" },
        path: "/demo",
      },
      new Request("https://registry.test/demo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
