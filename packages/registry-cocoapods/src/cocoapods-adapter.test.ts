import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { CocoapodsAdapter } from "./cocoapods-adapter";
import { buildPodVersionMeta, PodspecPublishSchema } from "./cocoapods-validation";
import { buildMultipartBody } from "./cocoapods-validation.test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

// md5("demo") = fe01ce2a7fbac8fafaed7c982a04e229 -> Specs/f/e/0/demo/...
const DEMO_SPEC_PATH = "Specs/f/e/0/demo/1.2.3/demo.podspec.json";

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

const storedMeta = buildPodVersionMeta(
  PodspecPublishSchema.parse({
    name: "demo",
    version: "1.2.3",
    summary: "a demo pod",
  }),
  { digest: DIGEST, sha256: HEX, filename: "demo-1.2.3.tar.gz" },
);

function cocoapodsContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "cocoapods", mountPath: "cocoapods/private" };
  return ctx;
}

describe("CocoaPods adapter", () => {
  test("declares index, podspec, download, and publish routes (literals before :pod)", () => {
    expect(new CocoapodsAdapter().routes()).toEqual([
      { method: "GET", pattern: "/all_pods.json", handlerId: "index" },
      { method: "GET", pattern: "/Specs/:tail+", handlerId: "podspec" },
      { method: "GET", pattern: "/pods/:pod/:version/:filename", handlerId: "download" },
      { method: "PUT", pattern: "/:pod", handlerId: "publish" },
    ]);
  });

  test("declares the documented capabilities", () => {
    expect(new CocoapodsAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new CocoapodsAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the artifact ref", () => {
    const adapter = new CocoapodsAdapter();
    const match = {
      entry: {
        method: "GET",
        pattern: "/pods/:pod/:version/:filename",
        handlerId: "download",
      },
      params: { pod: "demo", version: "1.2.3", filename: "demo-1.2.3.tar.gz" },
      path: "/pods/demo/1.2.3/demo-1.2.3.tar.gz",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "demo",
        artifactRef: "demo@1.2.3/demo-1.2.3.tar.gz",
      },
    });
  });

  test("podspec permission resolves the pod name from the sharded path", () => {
    const adapter = new CocoapodsAdapter();
    const match = {
      entry: { method: "GET", pattern: "/Specs/:tail+", handlerId: "podspec" },
      params: { tail: "f/e/0/demo/1.2.3/demo.podspec.json" },
      path: `/${DEMO_SPEC_PATH}`,
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("publish permission targets the pod package", () => {
    const adapter = new CocoapodsAdapter();
    const match = {
      entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
      params: { pod: "demo" },
      path: "/demo",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("PUT", match)).toEqual({
      action: "write",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("GET /all_pods.json lists pods with their versions, ordered + cacheable", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }, { name: "alpha" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (row, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      if (row.name === "alpha") {
        return [
          versionRow({ ...storedMeta, version: "0.1.0" }, "0.1.0"),
          versionRow({ ...storedMeta, version: "0.2.0" }, "0.2.0"),
        ];
      }
      return [versionRow(storedMeta)];
    };

    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "GET", pattern: "/all_pods.json", handlerId: "index" },
        params: {},
        path: "/all_pods.json",
      },
      new Request("https://registry.test/all_pods.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    // Alphabetical pod ordering: alpha before demo.
    expect(await res.text()).toBe(JSON.stringify({ alpha: ["0.1.0", "0.2.0"], demo: ["1.2.3"] }));

    if (!etag) throw new Error("expected ETag");
    const cached = await new CocoapodsAdapter().handle(
      {
        entry: { method: "GET", pattern: "/all_pods.json", handlerId: "index" },
        params: {},
        path: "/all_pods.json",
      },
      new Request("https://registry.test/all_pods.json", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET sharded podspec.json rewrites source to the hosted url + sha256", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkgRow("demo");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };

    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "GET", pattern: "/Specs/:tail+", handlerId: "podspec" },
        params: { tail: "f/e/0/demo/1.2.3/demo.podspec.json" },
        path: `/${DEMO_SPEC_PATH}`,
      },
      new Request(`https://registry.test/${DEMO_SPEC_PATH}`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      name: "demo",
      version: "1.2.3",
      summary: "a demo pod",
      source: {
        http: "https://registry.example.test/cocoapods/private/pods/demo/1.2.3/demo-1.2.3.tar.gz",
        sha256: HEX,
      },
    });
  });

  test("GET podspec 404s when the shard prefix does not match md5(pod)", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "GET", pattern: "/Specs/:tail+", handlerId: "podspec" },
        // demo shards to f/e/0, not a/b/c.
        params: { tail: "a/b/c/demo/1.2.3/demo.podspec.json" },
        path: "/Specs/a/b/c/demo/1.2.3/demo.podspec.json",
      },
      new Request("https://registry.test/Specs/a/b/c/demo/1.2.3/demo.podspec.json"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET podspec 404s when the package is unknown", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "GET", pattern: "/Specs/:tail+", handlerId: "podspec" },
        params: { tail: "f/e/0/demo/1.2.3/demo.podspec.json" },
        path: `/${DEMO_SPEC_PATH}`,
      },
      new Request(`https://registry.test/${DEMO_SPEC_PATH}`),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download resolves the stored blob digest for the matching filename", async () => {
    const ctx = cocoapodsContext();
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

    const res = await new CocoapodsAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/pods/:pod/:version/:filename",
          handlerId: "download",
        },
        params: { pod: "demo", version: "1.2.3", filename: "demo-1.2.3.tar.gz" },
        path: "/pods/demo/1.2.3/demo-1.2.3.tar.gz",
      },
      new Request("https://registry.test/pods/demo/1.2.3/demo-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("blob-bytes");
  });

  test("download 404s when the requested filename does not match the stored artifact", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    const res = await new CocoapodsAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/pods/:pod/:version/:filename",
          handlerId: "download",
        },
        params: { pod: "demo", version: "1.2.3", filename: "other.tar.gz" },
        path: "/pods/demo/1.2.3/other.tar.gz",
      },
      new Request("https://registry.test/pods/demo/1.2.3/other.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download 404s when the version is missing or not live", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => null;
    const res = await new CocoapodsAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/pods/:pod/:version/:filename",
          handlerId: "download",
        },
        params: { pod: "demo", version: "9.9.9", filename: "demo-9.9.9.tar.gz" },
        path: "/pods/demo/9.9.9/demo-9.9.9.tar.gz",
      },
      new Request("https://registry.test/pods/demo/9.9.9/demo-9.9.9.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download with an invalid pod name throws NAME_INVALID", async () => {
    const ctx = cocoapodsContext();
    await expect(
      new CocoapodsAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/pods/:pod/:version/:filename",
            handlerId: "download",
          },
          params: { pod: "bad name", version: "1.2.3", filename: "demo-1.2.3.tar.gz" },
          path: "/pods/bad%20name/1.2.3/demo-1.2.3.tar.gz",
        },
        new Request("https://registry.test/pods/bad%20name/1.2.3/demo-1.2.3.tar.gz"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("scan.referencedDigests surfaces the stored blob digest for scanning", () => {
    const scan = new CocoapodsAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    // Metadata without a blob digest references nothing.
    expect(scan?.referencedDigests?.({ podspec: { name: "demo", version: "1.0.0" } })).toEqual([]);
  });

  test("PUT /<pod> publishes the source archive and stores derived metadata", async () => {
    const ctx = cocoapodsContext();
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
        name: "podspec",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "demo", version: "1.2.3", summary: "a demo pod" }),
        ),
      },
      { name: "source", filename: "demo.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
        params: { pod: "demo" },
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
    expect(await res.json()).toEqual({ ok: true, pod: "demo", version: "1.2.3" });
    expect(committed.scan).toEqual({
      name: "demo",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      podspec: { name: "demo", version: "1.2.3", summary: "a demo pod" },
      blobDigest: DIGEST,
      sha256: HEX,
      filename: "demo-1.2.3.tar.gz",
    });
  });

  test("PUT /<pod> rejects a podspec whose name mismatches the path", async () => {
    const ctx = cocoapodsContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "podspec",
        data: new TextEncoder().encode(JSON.stringify({ name: "other", version: "1.2.3" })),
      },
      { name: "source", filename: "x.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
        params: { pod: "demo" },
        path: "/demo",
      },
      new Request("https://registry.test/demo", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "podspec name does not match the request path" });
  });

  test("PUT /<pod> returns 409 when the version already exists", async () => {
    const ctx = cocoapodsContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      {
        name: "podspec",
        data: new TextEncoder().encode(JSON.stringify({ name: "demo", version: "1.2.3" })),
      },
      { name: "source", filename: "demo.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
        params: { pod: "demo" },
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

  test("PUT /<pod> rejects a non-multipart body with 400", async () => {
    const ctx = cocoapodsContext();
    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
        params: { pod: "demo" },
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

  test("PUT /<pod> rejects a non-multipart content-type that carries a boundary= param", async () => {
    const ctx = cocoapodsContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "podspec",
        data: new TextEncoder().encode(JSON.stringify({ name: "demo", version: "1.2.3" })),
      },
      { name: "source", filename: "demo.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
        params: { pod: "demo" },
        path: "/demo",
      },
      new Request("https://registry.test/demo", {
        method: "PUT",
        // A boundary= param alone must not be enough; the media type must be multipart/form-data.
        headers: { "content-type": "text/plain; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("PUT /<pod> rejects an empty source part with 400", async () => {
    const ctx = cocoapodsContext();
    const body = buildMultipartBody("BOUND", [
      {
        name: "podspec",
        data: new TextEncoder().encode(JSON.stringify({ name: "demo", version: "1.2.3" })),
      },
      { name: "source", filename: "demo.tar.gz", data: new Uint8Array([]) },
    ]);
    const res = await new CocoapodsAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
        params: { pod: "demo" },
        path: "/demo",
      },
      new Request("https://registry.test/demo", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "'source' part is empty" });
  });

  test("PUT /<pod> with an invalid pod name throws NAME_INVALID", async () => {
    const ctx = cocoapodsContext();
    await expect(
      new CocoapodsAdapter().handle(
        {
          entry: { method: "PUT", pattern: "/:pod", handlerId: "publish" },
          params: { pod: "bad name" },
          path: "/bad%20name",
        },
        new Request("https://registry.test/bad%20name", {
          method: "PUT",
          headers: { "content-type": "multipart/form-data; boundary=BOUND" },
          body: new Uint8Array(),
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });
});
