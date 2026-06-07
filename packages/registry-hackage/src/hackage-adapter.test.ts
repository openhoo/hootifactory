import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
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

describe("Hackage adapter", () => {
  test("declares index, download, summary, and publish routes (literals first)", () => {
    expect(new HackageAdapter().routes()).toEqual([
      { method: "GET", pattern: "/01-index.tar.gz", handlerId: "index" },
      { method: "GET", pattern: "/package/:id/:file", handlerId: "download" },
      { method: "GET", pattern: "/package/:id", handlerId: "summary" },
      { method: "PUT", pattern: "/package/:id", handlerId: "publish" },
    ]);
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
});
