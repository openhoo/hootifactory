import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryPlugin,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { HackageAdapter } from "./hackage-adapter";
import { buildHackageVersionMeta } from "./hackage-metadata";
import { buildSdistTarGz } from "./hackage-tarball.test";

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

const CABAL = "name: demo\nversion: 1.2.3\nsynopsis: demo lib\nbuild-depends: base\n";

const storedMeta = buildHackageVersionMeta(
  {
    name: "demo",
    version: "1.2.3",
    synopsis: "demo lib",
    buildDepends: ["base"],
  },
  { cabal: CABAL, digest: DIGEST, sha256: HEX },
);

function hackageContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "hackage", mountPath: "hackage/private" };
  return ctx;
}

/**
 * A minimal stateful in-memory data layer wired to the SDK publish/serve
 * helpers, so a real publish flows through to the index, version list, and the
 * `.cabal`/sdist downloads with the bytes/checksums it actually persisted.
 */
function statefulHackageContext() {
  const ctx = hackageContext();
  const packages = new Map<string, RegistryPackageRow>();
  const versions = new Map<string, RegistryPackageVersionRow[]>();
  const blobs = new Map<string, Uint8Array>();

  ctx.data.packages.listNames = async () => [...packages.keys()].map((name) => ({ name }));
  ctx.data.packages.findByName = async (name) => packages.get(name) ?? null;
  ctx.data.packages.findOrCreate = async ({ name }) => {
    const existing = packages.get(name);
    if (existing) return existing;
    const row = pkgRow(name);
    packages.set(name, row);
    return row;
  };
  ctx.data.versions.exists = async (pkg, version) =>
    (versions.get(pkg.name) ?? []).some((row) => row.version === version);
  ctx.data.versions.findLive = async (pkg, version) =>
    (versions.get(pkg.name) ?? []).find((row) => row.version === version) ?? null;
  ctx.data.versions.listLive = async (pkg) => versions.get(pkg.name) ?? [];
  ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(input.data).digest("hex")}`;
    blobs.set(digest, input.data);
    return { digest, size: input.data.length, deduped: false, refCreated: true, blobRefId: "ref" };
  };
  ctx.data.versions.commitOrReleaseBlob = async (input) => {
    const list = versions.get(input.package.name) ?? [];
    list.push(versionRow(input.metadata, input.version));
    versions.set(input.package.name, list);
    return { versionId: `ver_${input.version}` };
  };
  ctx.data.content.blobRefExists = async ({ digest }) => blobs.has(digest);
  ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
    const bytes = blobs.get(digest);
    if (!bytes) return new Response("Not Found", { status: 404 });
    return new Response(bytes, { headers: { "content-type": contentType } });
  };
  return ctx;
}

function indexMatch(pattern: string, handlerId: string, path: string): RouteMatch {
  return { entry: { method: "GET", pattern, handlerId }, params: {}, path };
}

describe("Hackage adapter", () => {
  test("declares index, download, summary, and publish routes (literals first)", () => {
    expect(new HackageAdapter().routes()).toEqual([
      { method: "GET", pattern: "/01-index.tar.gz", handlerId: "index" },
      { method: "GET", pattern: "/01-index.tar", handlerId: "indexPlain" },
      { method: "GET", pattern: "/00-index.tar.gz", handlerId: "indexLegacy" },
      { method: "POST", pattern: "/packages/", handlerId: "publishUpload" },
      {
        method: "GET",
        pattern: "/package/:id/preferred-versions",
        handlerId: "preferredVersions",
      },
      { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
      { method: "GET", pattern: "/package/:id", handlerId: "summary" },
      { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
    ]);
  });

  test("declares virtualizable but not proxyable (no proxyIngest handler)", () => {
    const adapter: RegistryPlugin = new HackageAdapter();
    expect(adapter.capabilities.virtualizable).toBe(true);
    expect(adapter.capabilities.proxyable).toBe(false);
    expect(adapter.proxyIngest).toBeUndefined();
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new HackageAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the artifact ref derived from the id", () => {
    const adapter = new HackageAdapter();
    const match = {
      entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
      params: { id: "demo-1.2.3", file: "demo-1.2.3.tar.gz" },
      path: "/package/demo-1.2.3/demo-1.2.3.tar.gz",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "artifact", packageName: "demo", artifactRef: "demo@1.2.3" },
    });
  });

  test("summary permission targets the package name (versioned id)", () => {
    const adapter = new HackageAdapter();
    const match = {
      entry: { method: "GET", pattern: "/package/:id", handlerId: "summary" },
      params: { id: "demo-1.2.3" },
      path: "/package/demo-1.2.3",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("version-list permission targets the bare package name", () => {
    const adapter = new HackageAdapter();
    const match = {
      entry: { method: "GET", pattern: "/package/:id", handlerId: "summary" },
      params: { id: "demo" },
      path: "/package/demo",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("GET /01-index.tar.gz regenerates the index from live versions, cacheable", async () => {
    const ctx = hackageContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }, { name: "alpha" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (row, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      const name = row.name;
      return [
        versionRow(
          buildHackageVersionMeta(
            { name, version: "1.0", buildDepends: [] },
            { cabal: `name: ${name}\nversion: 1.0\n`, digest: DIGEST, sha256: HEX },
          ),
          "1.0",
        ),
      ];
    };

    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/01-index.tar.gz", handlerId: "index" },
        params: {},
        path: "/01-index.tar.gz",
      },
      new Request("https://registry.test/01-index.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    const tar = gunzipSync(new Uint8Array(await res.arrayBuffer()));
    const text = new TextDecoder().decode(tar);
    // Alphabetical ordering: alpha's cabal entry precedes demo's.
    expect(text.indexOf("alpha/1.0/alpha.cabal")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("demo/1.0/demo.cabal")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("alpha/1.0/alpha.cabal")).toBeLessThan(text.indexOf("demo/1.0/demo.cabal"));

    if (!etag) throw new Error("expected ETag");
    const cached = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/01-index.tar.gz", handlerId: "index" },
        params: {},
        path: "/01-index.tar.gz",
      },
      new Request("https://registry.test/01-index.tar.gz", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /package/<name>-<version> returns the version summary with hosted urls", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkgRow("demo");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };

    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id", handlerId: "summary" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      name: "demo",
      version: "1.2.3",
      synopsis: "demo lib",
      buildDepends: ["base"],
      tarballUrl:
        "https://registry.example.test/hackage/private/package/demo-1.2.3/demo-1.2.3.tar.gz",
      cabalUrl: "https://registry.example.test/hackage/private/package/demo-1.2.3/demo.cabal",
      sha256: HEX,
    });
  });

  test("GET /package/<name> lists live versions in version order", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.listLive = async () => [
      versionRow(
        buildHackageVersionMeta(
          { name: "demo", version: "2.0", buildDepends: [] },
          { cabal: "c", digest: DIGEST, sha256: HEX },
        ),
        "2.0",
      ),
      versionRow(
        buildHackageVersionMeta(
          { name: "demo", version: "1.2.3", buildDepends: [] },
          { cabal: "c", digest: DIGEST, sha256: HEX },
        ),
        "1.2.3",
      ),
    ];

    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id", handlerId: "summary" },
        params: { id: "demo" },
        path: "/package/demo",
      },
      new Request("https://registry.test/package/demo"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "demo", versions: ["1.2.3", "2.0"] });
  });

  test("GET /package/<name> 404s when the package is unknown", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id", handlerId: "summary" },
        params: { id: "missing" },
        path: "/package/missing",
      },
      new Request("https://registry.test/package/missing"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download serves the stored sdist blob for the canonical tarball name", async () => {
    const ctx = hackageContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("sdist-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
        params: { id: "demo-1.2.3", file: "demo-1.2.3.tar.gz" },
        path: "/package/demo-1.2.3/demo-1.2.3.tar.gz",
      },
      new Request("https://registry.test/package/demo-1.2.3/demo-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("sdist-bytes");
  });

  test("download serves the stored .cabal text for <name>.cabal", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);

    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
        params: { id: "demo-1.2.3", file: "demo.cabal" },
        path: "/package/demo-1.2.3/demo.cabal",
      },
      new Request("https://registry.test/package/demo-1.2.3/demo.cabal"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(CABAL);
  });

  test("download 404s when the requested file matches neither tarball nor cabal", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
        params: { id: "demo-1.2.3", file: "other.txt" },
        path: "/package/demo-1.2.3/other.txt",
      },
      new Request("https://registry.test/package/demo-1.2.3/other.txt"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download 404s when the version is missing or not live", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => null;
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
        params: { id: "demo-9.9.9", file: "demo-9.9.9.tar.gz" },
        path: "/package/demo-9.9.9/demo-9.9.9.tar.gz",
      },
      new Request("https://registry.test/package/demo-9.9.9/demo-9.9.9.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download with a malformed package id throws NAME_INVALID", async () => {
    const ctx = hackageContext();
    await expect(
      new HackageAdapter().handle(
        {
          entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
          params: { id: "not-a-version", file: "x.tar.gz" },
          path: "/package/not-a-version/x.tar.gz",
        },
        new Request("https://registry.test/package/not-a-version/x.tar.gz"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("scan.referencedDigests surfaces the stored blob digest", () => {
    const scan = new HackageAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ name: "demo" })).toEqual([]);
  });

  test("PUT /package/<id> publishes the sdist and stores derived metadata", async () => {
    const ctx = hackageContext();
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

    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3", {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: sdist,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, package: "demo-1.2.3" });
    expect(committed.scan).toEqual({
      name: "demo",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      name: "demo",
      version: "1.2.3",
      synopsis: "demo lib",
      buildDepends: ["base"],
      blobDigest: DIGEST,
      sha256: HEX,
      cabal: CABAL,
    });
  });

  test("PUT /package/<id> returns 409 when the version already exists", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3", {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: sdist,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("PUT /package/<id> 400s when the .cabal id does not match the url id", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;

    const sdist = buildSdistTarGz([
      { path: "demo-1.2.3/demo.cabal", content: "name: demo\nversion: 9.9.9\n" },
    ]);
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3", {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: sdist,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("PUT /package/<id> with a malformed id throws NAME_INVALID", async () => {
    const ctx = hackageContext();
    await expect(
      new HackageAdapter().handle(
        {
          entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
          params: { id: "no-version-here" },
          path: "/package/no-version-here",
        },
        new Request("https://registry.test/package/no-version-here", { method: "PUT" }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("GET /01-index.tar serves the uncompressed index as x-tar", async () => {
    const ctx = hackageContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new HackageAdapter().handle(
      indexMatch("/01-index.tar", "indexPlain", "/01-index.tar"),
      new Request("https://registry.test/01-index.tar"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    // The body is already-uncompressed tar (no gzip magic), readable directly.
    const tar = new Uint8Array(await res.arrayBuffer());
    expect(tar[0]).not.toBe(0x1f); // not a gzip stream
    expect(new TextDecoder().decode(tar).indexOf("demo/1.2.3/demo.cabal")).toBeGreaterThanOrEqual(
      0,
    );
  });

  test("GET /00-index.tar.gz serves the legacy gzipped index", async () => {
    const ctx = hackageContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new HackageAdapter().handle(
      indexMatch("/00-index.tar.gz", "indexLegacy", "/00-index.tar.gz"),
      new Request("https://registry.test/00-index.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const tar = gunzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(tar).indexOf("demo/1.2.3/demo.cabal")).toBeGreaterThanOrEqual(
      0,
    );
  });

  test("GET /package/<name>/preferred-versions serves a permissive document", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new HackageAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/package/:id/preferred-versions",
          handlerId: "preferredVersions",
        },
        params: { id: "demo" },
        path: "/package/demo/preferred-versions",
      },
      new Request("https://registry.test/package/demo/preferred-versions"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      name: "demo",
      "preferred-versions": [],
      deprecated: [],
    });
  });

  test("preferred-versions 404s for an unknown package", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new HackageAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/package/:id/preferred-versions",
          handlerId: "preferredVersions",
        },
        params: { id: "missing" },
        path: "/package/missing/preferred-versions",
      },
      new Request("https://registry.test/package/missing/preferred-versions"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("POST /packages/ publishes a multipart upload, deriving id from the .cabal", async () => {
    const ctx = statefulHackageContext();
    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const form = new FormData();
    form.set("package", new File([sdist], "demo-1.2.3.tar.gz", { type: "application/gzip" }));

    const res = await new HackageAdapter().handle(
      {
        entry: { method: "POST", pattern: "/packages/", handlerId: "publishUpload" },
        params: {},
        path: "/packages/",
      },
      new Request("https://registry.test/packages/", { method: "POST", body: form }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, package: "demo-1.2.3" });
  });

  test("POST /packages/ 400s when the multipart 'package' field is missing", async () => {
    const ctx = hackageContext();
    const form = new FormData();
    form.set("notpackage", new File([new Uint8Array([1, 2, 3])], "x.tar.gz"));
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "POST", pattern: "/packages/", handlerId: "publishUpload" },
        params: {},
        path: "/packages/",
      },
      new Request("https://registry.test/packages/", { method: "POST", body: form }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing 'package' file field" });
  });

  test("publish rejects an empty body with 400", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3", {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: new Uint8Array(0),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "package archive is empty" });
  });

  test("publish rejects a non-gzip / non-tar body with 400", async () => {
    const ctx = hackageContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    const res = await new HackageAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3", {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "archive is not a valid .tar.gz sdist or has no .cabal file",
    });
  });

  test("round-trip: publish then read the index, version list, cabal, and sdist bytes", async () => {
    const ctx = statefulHackageContext();
    const adapter = new HackageAdapter();
    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const expectedSha = new Bun.CryptoHasher("sha256").update(sdist).digest("hex");

    // (1) publish
    const published = await adapter.handle(
      {
        entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
        params: { id: "demo-1.2.3" },
        path: "/package/demo-1.2.3",
      },
      new Request("https://registry.test/package/demo-1.2.3", {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: sdist,
      }),
      ctx,
    );
    expect(published.status).toBe(201);

    // (2) the version list reflects the publish
    const list = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/package/:id", handlerId: "summary" },
        params: { id: "demo" },
        path: "/package/demo",
      },
      new Request("https://registry.test/package/demo"),
      ctx,
    );
    expect(await list.json()).toEqual({ name: "demo", versions: ["1.2.3"] });

    // (3) the 01-index contains the exact uploaded .cabal under the canonical path
    const index = await adapter.handle(
      indexMatch("/01-index.tar.gz", "index", "/01-index.tar.gz"),
      new Request("https://registry.test/01-index.tar.gz"),
      ctx,
    );
    const indexTar = gunzipSync(new Uint8Array(await index.arrayBuffer()));
    const indexText = new TextDecoder().decode(indexTar);
    expect(indexText).toContain("demo/1.2.3/demo.cabal");
    expect(indexText).toContain(CABAL);

    // (4) the .cabal download returns the same text verbatim
    const cabal = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
        params: { id: "demo-1.2.3", file: "demo.cabal" },
        path: "/package/demo-1.2.3/demo.cabal",
      },
      new Request("https://registry.test/package/demo-1.2.3/demo.cabal"),
      ctx,
    );
    expect(await cabal.text()).toBe(CABAL);

    // (5) the sdist download serves the exact bytes published (sha256 matches)
    const download = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
        params: { id: "demo-1.2.3", file: "demo-1.2.3.tar.gz" },
        path: "/package/demo-1.2.3/demo-1.2.3.tar.gz",
      },
      new Request("https://registry.test/package/demo-1.2.3/demo-1.2.3.tar.gz"),
      ctx,
    );
    const served = new Uint8Array(await download.arrayBuffer());
    expect(served.length).toBe(sdist.length);
    expect(new Bun.CryptoHasher("sha256").update(served).digest("hex")).toBe(expectedSha);
  });

  test("round-trip: re-publishing the same version conflicts (409) via persisted state", async () => {
    const ctx = statefulHackageContext();
    const adapter = new HackageAdapter();
    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const publish = () =>
      adapter.handle(
        {
          entry: { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
          params: { id: "demo-1.2.3" },
          path: "/package/demo-1.2.3",
        },
        new Request("https://registry.test/package/demo-1.2.3", {
          method: "PUT",
          headers: { "content-type": "application/gzip" },
          body: sdist,
        }),
        ctx,
      );

    expect((await publish()).status).toBe(201);
    const second = await publish();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "version already exists" });
  });
});
