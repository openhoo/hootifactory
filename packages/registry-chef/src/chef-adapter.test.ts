import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { ChefAdapter, mergeChefCookbooks } from "./chef-adapter";
import { buildChefVersionMeta, ChefPublishMetadataSchema } from "./chef-validation";
import { buildMultipartBody } from "./chef-validation.test";

const DIGEST = `sha256:${"a".repeat(64)}`;

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
  sizeBytes = 4,
): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_nginx",
    version,
    metadata,
    sizeBytes,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const storedMeta = buildChefVersionMeta(
  ChefPublishMetadataSchema.parse({
    name: "nginx",
    version: "1.2.3",
    description: "Installs nginx",
    maintainer: "acme",
    license: "Apache-2.0",
    category: "Web Servers",
    dependencies: { apt: ">= 2.0.0" },
  }),
  { digest: DIGEST },
);

function chefContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "chef", mountPath: "chef/private" };
  return ctx;
}

function handle(match: RouteMatch, req: Request, ctx = chefContext()) {
  return new ChefAdapter().handle(match, req, ctx);
}

describe("Chef adapter", () => {
  test("declares universe/publish/download/version/cookbook routes (literal before :name)", () => {
    expect(new ChefAdapter().routes()).toEqual([
      { method: "GET", pattern: "/universe", handlerId: "universe" },
      { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
      {
        method: "GET",
        pattern: "/api/v1/cookbooks/:name/versions/:version/download",
        handlerId: "download",
      },
      {
        method: "GET",
        pattern: "/api/v1/cookbooks/:name/versions/:version",
        handlerId: "cookbookVersion",
      },
      {
        method: "GET",
        pattern: "/api/v1/cookbooks/:name",
        handlerId: "cookbook",
        proxyRefreshTrigger: true,
        metadataMergeable: true,
        packageParam: "name",
      },
    ]);
  });

  test("declares proxyable + virtualizable capabilities", () => {
    expect(new ChefAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
  });

  test("reads use read perms, publish uses write, basic auth challenge", () => {
    const adapter = new ChefAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("cookbook permission targets the package", () => {
    const adapter = new ChefAdapter();
    const match = {
      entry: { method: "GET", pattern: "/api/v1/cookbooks/:name", handlerId: "cookbook" },
      params: { name: "nginx" },
      path: "/api/v1/cookbooks/nginx",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "nginx" },
    });
  });

  test("download permission targets the artifact ref (underscored version normalized)", () => {
    const adapter = new ChefAdapter();
    const match = {
      entry: {
        method: "GET",
        pattern: "/api/v1/cookbooks/:name/versions/:version/download",
        handlerId: "download",
      },
      params: { name: "nginx", version: "1_2_3" },
      path: "/api/v1/cookbooks/nginx/versions/1_2_3/download",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "artifact", packageName: "nginx", artifactRef: "nginx@1.2.3" },
    });
  });

  test("GET /universe lists cookbooks -> versions -> entries, ordered + cacheable", async () => {
    const ctx = chefContext();
    ctx.data.packages.listNames = async () => [{ name: "nginx" }, { name: "apache" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (row, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow({ ...storedMeta, version: row.name === "apache" ? "2.0.0" : "1.2.3" })];
    };

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/universe", handlerId: "universe" },
        params: {},
        path: "/universe",
      },
      new Request("https://registry.test/universe"),
      ctx,
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    // Alphabetical ordering: apache before nginx.
    expect(Object.keys(body)).toEqual(["apache", "nginx"]);
    expect(body.nginx?.["1.2.3"]).toEqual({
      location_type: "opscode",
      location_path: "https://registry.example.test/chef/private/api/v1/cookbooks",
      download_url:
        "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3/download",
      dependencies: { apt: ">= 2.0.0" },
    });

    if (!etag) throw new Error("expected ETag");
    const cached = await handle(
      {
        entry: { method: "GET", pattern: "/universe", handlerId: "universe" },
        params: {},
        path: "/universe",
      },
      new Request("https://registry.test/universe", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /api/v1/cookbooks/:name returns cookbook JSON with version URLs", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("nginx");
      return pkgRow("nginx");
    };
    ctx.data.versions.listLive = async () => [
      versionRow({ ...storedMeta, version: "1.2.3" }, "1.2.3"),
      versionRow({ ...storedMeta, version: "1.0.0" }, "1.0.0"),
    ];

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/cookbooks/:name", handlerId: "cookbook" },
        params: { name: "nginx" },
        path: "/api/v1/cookbooks/nginx",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: string[] };
    expect(body).toMatchObject({
      name: "nginx",
      maintainer: "acme",
      category: "Web Servers",
      average_rating: null,
      deprecated: false,
      latest_version:
        "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3",
    });
    expect(body.versions).toEqual([
      "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3",
      "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_0_0",
    ]);
  });

  test("GET /api/v1/cookbooks/:name 404s for an unknown cookbook", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => null;
    const res = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/cookbooks/:name", handlerId: "cookbook" },
        params: { name: "missing" },
        path: "/api/v1/cookbooks/missing",
      },
      new Request("https://registry.test/api/v1/cookbooks/missing"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET version detail returns file url + average_rating + dependencies", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta, "1.2.3", 4096);
    };

    const res = await handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/v1/cookbooks/:name/versions/:version",
          handlerId: "cookbookVersion",
        },
        params: { name: "nginx", version: "1_2_3" },
        path: "/api/v1/cookbooks/nginx/versions/1_2_3",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx/versions/1_2_3"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.2.3",
      license: "Apache-2.0",
      description: "Installs nginx",
      average_rating: null,
      cookbook: "https://registry.example.test/chef/private/api/v1/cookbooks/nginx",
      file: "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3/download",
      dependencies: { apt: ">= 2.0.0" },
      tarball_file_size: 4096,
      published_at: storedMeta.published,
    });
  });

  test("download resolves the stored tarball digest", async () => {
    const ctx = chefContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("tarball-bytes", { headers: { "content-type": contentType } });
    };

    const res = await handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/v1/cookbooks/:name/versions/:version/download",
          handlerId: "download",
        },
        params: { name: "nginx", version: "1_2_3" },
        path: "/api/v1/cookbooks/nginx/versions/1_2_3/download",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx/versions/1_2_3/download"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("tarball-bytes");
  });

  test("download 404s when the version is missing or not live", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.findLive = async () => null;
    const res = await handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/v1/cookbooks/:name/versions/:version/download",
          handlerId: "download",
        },
        params: { name: "nginx", version: "9_9_9" },
        path: "/api/v1/cookbooks/nginx/versions/9_9_9/download",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx/versions/9_9_9/download"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("an invalid cookbook name throws NAME_INVALID", async () => {
    const ctx = chefContext();
    await expect(
      handle(
        {
          entry: { method: "GET", pattern: "/api/v1/cookbooks/:name", handlerId: "cookbook" },
          params: { name: "Bad Name" },
          path: "/api/v1/cookbooks/Bad%20Name",
        },
        new Request("https://registry.test/api/v1/cookbooks/Bad%20Name"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("scan.referencedDigests surfaces the stored tarball digest", () => {
    const scan = new ChefAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ version: "1.0.0" })).toEqual([]);
  });

  test("scan.dependencyGraph exposes the cookbook dependency map", () => {
    const scan = new ChefAdapter().scan;
    expect(scan?.dependencyGraph?.({ metadata: { ...storedMeta } })).toEqual({
      deps: { apt: ">= 2.0.0" },
      osvEcosystem: undefined,
      purlType: "chef",
    });
  });

  test("POST /api/v1/cookbooks publishes the tarball and stores derived metadata", async () => {
    const ctx = chefContext();
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
        name: "cookbook",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "nginx", version: "1.2.3", description: "Installs nginx" }),
        ),
      },
      { name: "tarball", filename: "nginx-1.2.3.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await handle(
      {
        entry: { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ uri: "cookbooks/nginx" });
    expect(committed.scan).toEqual({
      name: "nginx",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      version: "1.2.3",
      description: "Installs nginx",
      tarballDigest: DIGEST,
    });
  });

  test("POST returns 409 when the version already exists", async () => {
    const ctx = chefContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      {
        name: "cookbook",
        data: new TextEncoder().encode(JSON.stringify({ name: "nginx", version: "1.2.3" })),
      },
      { name: "tarball", filename: "nginx-1.2.3.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const res = await handle(
      {
        entry: { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "COOKBOOK_VERSION_EXISTS" });
  });

  test("POST rejects a missing 'name' in the cookbook metadata with 400", async () => {
    const ctx = chefContext();
    const body = buildMultipartBody("BOUND", [
      { name: "cookbook", data: new TextEncoder().encode(JSON.stringify({ version: "1.2.3" })) },
      { name: "tarball", filename: "nginx-1.2.3.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const res = await handle(
      {
        entry: { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "MISSING_DATA" });
  });

  test("POST rejects a non-multipart body with 400", async () => {
    const ctx = chefContext();
    const res = await handle(
      {
        entry: { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("generateMetadata returns the cookbook listing for virtual merge", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];
    const adapter = new ChefAdapter();
    const metadata = await adapter.generateMetadata?.("nginx", ctx);
    expect(metadata?.contentType).toContain("application/json");
    expect(JSON.parse(metadata?.body as string)).toMatchObject({ name: "nginx" });
  });

  test("generateMetadata returns null for an unknown cookbook", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => null;
    expect(await new ChefAdapter().generateMetadata?.("missing", ctx)).toBeNull();
  });

  test("mergeChefCookbooks unions version URLs across members, first member wins base", () => {
    const merged = mergeChefCookbooks([
      {
        contentType: "application/json",
        body: JSON.stringify({ name: "nginx", versions: ["a", "b"] }),
      },
      {
        contentType: "application/json",
        body: JSON.stringify({ name: "other", versions: ["b", "c"] }),
      },
    ]);
    const body = JSON.parse(merged.body as string);
    expect(body.name).toBe("nginx");
    expect(body.versions).toEqual(["a", "b", "c"]);
  });
});
