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
  test("declares universe/search/list/publish/download/version/cookbook routes (literal before :name)", () => {
    expect(new ChefAdapter().routes()).toEqual([
      { method: "GET", pattern: "/universe", handlerId: "universe" },
      { method: "GET", pattern: "/api/v1/universe", handlerId: "universeV1" },
      { method: "GET", pattern: "/api/v1/search", handlerId: "search" },
      { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
      { method: "GET", pattern: "/api/v1/cookbooks", handlerId: "cookbookIndex" },
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
    const entry = body.nginx?.["1.2.3"] as {
      location_type: string;
      location_path: string;
      download_url: string;
      dependencies: unknown;
    };
    expect(entry).toEqual({
      location_type: "supermarket",
      // The `/api/v1` root, NOT `/api/v1/cookbooks`: berkshelf joins the relative
      // `cookbooks/<name>/versions/<version>` onto this base by concatenation.
      location_path: "https://registry.example.test/chef/private/api/v1",
      download_url:
        "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3/download",
      dependencies: { apt: ">= 2.0.0" },
    });
    // berkshelf joins `cookbooks/<name>/versions/<underscored>` onto location_path;
    // assert that resolves to the actual cookbookVersion route URL (no doubled segment).
    expect(`${entry.location_path}/cookbooks/nginx/versions/1_2_3`).toBe(
      "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3",
    );

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

  test("GET /api/v1/universe serves the same document as /universe", async () => {
    const ctx = chefContext();
    ctx.data.packages.listNames = async () => [{ name: "nginx" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/universe", handlerId: "universeV1" },
        params: {},
        path: "/api/v1/universe",
      },
      new Request("https://registry.test/api/v1/universe"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body.nginx?.["1.2.3"]).toMatchObject({
      location_type: "supermarket",
      location_path: "https://registry.example.test/chef/private/api/v1",
    });
  });

  test("GET /universe sorts each cookbook's versions newest-first (deterministic keys)", async () => {
    const ctx = chefContext();
    ctx.data.packages.listNames = async () => [{ name: "nginx" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    // Return versions in a non-sorted, ingest-like order (1.0.0 created last).
    ctx.data.versions.listLive = async () => [
      versionRow({ ...storedMeta, version: "1.2.0" }, "1.2.0"),
      versionRow({ ...storedMeta, version: "2.0.0" }, "2.0.0"),
      versionRow({ ...storedMeta, version: "1.0.0" }, "1.0.0"),
    ];

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/universe", handlerId: "universe" },
        params: {},
        path: "/universe",
      },
      new Request("https://registry.test/universe"),
      ctx,
    );
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    // Key order is by version, descending — independent of the DB row order.
    expect(Object.keys(body.nginx ?? {})).toEqual(["2.0.0", "1.2.0", "1.0.0"]);
  });

  test("GET /api/v1/cookbooks lists cookbooks with the {start,total,items} envelope", async () => {
    const ctx = chefContext();
    ctx.data.packages.listNames = async () => [{ name: "nginx" }, { name: "apache" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (row) => [
      versionRow({ ...storedMeta, version: row.name === "apache" ? "2.0.0" : "1.2.3" }),
    ];

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/cookbooks", handlerId: "cookbookIndex" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks?items=10&start=0"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      start: number;
      total: number;
      items: {
        cookbook_name: string;
        cookbook: string;
        cookbook_maintainer: string;
        cookbook_description: string;
      }[];
    };
    expect(body.start).toBe(0);
    expect(body.total).toBe(2);
    // Alphabetical: apache before nginx.
    expect(body.items.map((i) => i.cookbook_name)).toEqual(["apache", "nginx"]);
    expect(body.items[0]).toEqual({
      cookbook_name: "apache",
      cookbook: "https://registry.example.test/chef/private/api/v1/cookbooks/apache",
      cookbook_maintainer: "acme",
      cookbook_description: "Installs nginx",
    });
  });

  test("GET /api/v1/cookbooks windows results by start/items", async () => {
    const ctx = chefContext();
    ctx.data.packages.listNames = async () => [{ name: "a" }, { name: "b" }, { name: "c" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/cookbooks", handlerId: "cookbookIndex" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks?items=1&start=1"),
      ctx,
    );
    const body = (await res.json()) as {
      start: number;
      total: number;
      items: { cookbook_name: string }[];
    };
    expect(body.total).toBe(3);
    expect(body.start).toBe(1);
    expect(body.items.map((i) => i.cookbook_name)).toEqual(["b"]);
  });

  test("GET /api/v1/search filters cookbooks by the q query param", async () => {
    const ctx = chefContext();
    ctx.data.packages.listNames = async () => [{ name: "nginx" }, { name: "apache" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/search", handlerId: "search" },
        params: {},
        path: "/api/v1/search",
      },
      new Request("https://registry.test/api/v1/search?q=ngin&items=10&start=0"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; items: { cookbook_name: string }[] };
    expect(body.total).toBe(1);
    expect(body.items.map((i) => i.cookbook_name)).toEqual(["nginx"]);
  });

  test("GET version detail resolves the 'latest' alias to the newest live version", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.listLive = async () => [
      versionRow({ ...storedMeta, version: "1.0.0" }, "1.0.0"),
      versionRow({ ...storedMeta, version: "2.1.0" }, "2.1.0"),
    ];

    const res = await handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/v1/cookbooks/:name/versions/:version",
          handlerId: "cookbookVersion",
        },
        params: { name: "nginx", version: "latest" },
        path: "/api/v1/cookbooks/nginx/versions/latest",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx/versions/latest"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe("2.1.0");
  });

  test("download resolves the 'latest' alias to the newest version's tarball", async () => {
    const ctx = chefContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.listLive = async () => [
      versionRow({ ...storedMeta, version: "1.0.0" }, "1.0.0"),
      versionRow({ ...storedMeta, version: "2.1.0" }, "2.1.0"),
    ];
    const seenScope: { scope?: string } = {};
    ctx.data.content.blobRefExists = async (opts: { scope?: string }) => {
      seenScope.scope = opts.scope;
      return true;
    };
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
        params: { name: "nginx", version: "latest" },
        path: "/api/v1/cookbooks/nginx/versions/latest/download",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx/versions/latest/download"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    // The blob scope reflects the resolved newest version, not the "latest" literal.
    expect(seenScope.scope).toBe("nginx@2.1.0");
  });

  test("'latest' alias 404s when the cookbook has no live versions", async () => {
    const ctx = chefContext();
    ctx.data.packages.findByName = async () => pkgRow("nginx");
    ctx.data.versions.listLive = async () => [];
    await expect(
      handle(
        {
          entry: {
            method: "GET",
            pattern: "/api/v1/cookbooks/:name/versions/:version",
            handlerId: "cookbookVersion",
          },
          params: { name: "nginx", version: "latest" },
          path: "/api/v1/cookbooks/nginx/versions/latest",
        },
        new Request("https://registry.test/api/v1/cookbooks/nginx/versions/latest"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
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
    await expect(
      handle(
        {
          entry: { method: "GET", pattern: "/api/v1/cookbooks/:name", handlerId: "cookbook" },
          params: { name: "missing" },
          path: "/api/v1/cookbooks/missing",
        },
        new Request("https://registry.test/api/v1/cookbooks/missing"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
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
      platforms: {},
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
    await expect(
      handle(
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
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
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
    expect(await res.json()).toEqual({
      uri: "https://registry.example.test/chef/private/api/v1/cookbooks/nginx",
    });
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

  test("mergeChefCookbooks re-sorts merged version URLs newest-first", () => {
    const url = (v: string) => `https://h/r/api/v1/cookbooks/nginx/versions/${v}`;
    const merged = mergeChefCookbooks([
      {
        contentType: "application/json",
        body: JSON.stringify({ name: "nginx", versions: [url("1_0_0"), url("1_2_0")] }),
      },
      {
        contentType: "application/json",
        body: JSON.stringify({ name: "nginx", versions: [url("1_1_0"), url("2_0_0")] }),
      },
    ]);
    const body = JSON.parse(merged.body as string);
    expect(body.versions).toEqual([url("2_0_0"), url("1_2_0"), url("1_1_0"), url("1_0_0")]);
  });

  test("publish -> /universe + cookbook + version detail expose one consistent row", async () => {
    const ctx = chefContext();
    const captured: { metadata?: Record<string, unknown> } = {};
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
      captured.metadata = input.metadata;
      return { versionId: "ver_1" };
    };

    const publishBody = buildMultipartBody("BOUND", [
      {
        name: "cookbook",
        data: new TextEncoder().encode(
          JSON.stringify({
            name: "nginx",
            version: "1.2.3",
            description: "Installs nginx",
            maintainer: "acme",
            dependencies: { apt: ">= 2.0.0" },
          }),
        ),
      },
      { name: "tarball", filename: "nginx-1.2.3.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const publishRes = await handle(
      {
        entry: { method: "POST", pattern: "/api/v1/cookbooks", handlerId: "publish" },
        params: {},
        path: "/api/v1/cookbooks",
      },
      new Request("https://registry.test/api/v1/cookbooks", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: publishBody,
      }),
      ctx,
    );
    expect(publishRes.status).toBe(201);
    const stored = captured.metadata;
    if (!stored) throw new Error("expected stored metadata");

    // Now read every surface from that single stored row.
    const readCtx = chefContext();
    readCtx.data.packages.listNames = async () => [{ name: "nginx" }];
    readCtx.data.packages.findByName = async () => pkgRow("nginx");
    readCtx.data.versions.listLive = async () => [versionRow(stored)];
    readCtx.data.versions.findLive = async () => versionRow(stored, "1.2.3", 4096);

    const universeRes = await handle(
      {
        entry: { method: "GET", pattern: "/universe", handlerId: "universe" },
        params: {},
        path: "/universe",
      },
      new Request("https://registry.test/universe"),
      readCtx,
    );
    const universe = (await universeRes.json()) as Record<
      string,
      Record<string, { dependencies: unknown; download_url: string }>
    >;
    const versionUrl =
      "https://registry.example.test/chef/private/api/v1/cookbooks/nginx/versions/1_2_3";
    expect(universe.nginx?.["1.2.3"]?.dependencies).toEqual({ apt: ">= 2.0.0" });
    expect(universe.nginx?.["1.2.3"]?.download_url).toBe(`${versionUrl}/download`);

    const cookbookRes = await handle(
      {
        entry: { method: "GET", pattern: "/api/v1/cookbooks/:name", handlerId: "cookbook" },
        params: { name: "nginx" },
        path: "/api/v1/cookbooks/nginx",
      },
      new Request("https://registry.test/api/v1/cookbooks/nginx"),
      readCtx,
    );
    const cookbook = (await cookbookRes.json()) as {
      name: string;
      maintainer: string;
      description: string;
      versions: string[];
    };
    expect(cookbook).toMatchObject({
      name: "nginx",
      maintainer: "acme",
      description: "Installs nginx",
    });
    expect(cookbook.versions).toEqual([versionUrl]);

    const detailRes = await handle(
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
      readCtx,
    );
    const detail = (await detailRes.json()) as {
      version: string;
      description: string;
      dependencies: unknown;
      file: string;
    };
    // The same dependencies / description / download URL appear on every surface.
    expect(detail).toMatchObject({
      version: "1.2.3",
      description: "Installs nginx",
      dependencies: { apt: ">= 2.0.0" },
      file: `${versionUrl}/download`,
    });
  });
});
