import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { HexAdapter } from "./hex-adapter";
import { demoHexTarball } from "./hex-tarball.test";
import { buildHexVersionMeta, HexReleaseMetadataSchema } from "./hex-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OUTER = "a".repeat(64);
const INNER = "b".repeat(64);

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

const storedMeta = buildHexVersionMeta(
  HexReleaseMetadataSchema.parse({
    name: "demo",
    version: "1.2.3",
    app: "demo",
    description: "a demo package",
    licenses: ["MIT"],
    build_tools: ["mix"],
    requirements: { poison: "~> 1.0" },
  }),
  { digest: DIGEST, outerChecksum: OUTER, innerChecksum: INNER },
);

function hexContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "hex", mountPath: "hex/private", name: "private" };
  return ctx;
}

function match(
  entry: RouteMatch["entry"],
  params: Record<string, string>,
  path: string,
): RouteMatch {
  return { entry, params, path };
}

describe("Hex adapter", () => {
  test("declares the full route table with static routes before :name catch-alls", () => {
    expect(new HexAdapter().routes()).toEqual([
      { method: "POST", pattern: "/api/publish", handlerId: "publish" },
      { method: "POST", pattern: "/publish", handlerId: "publish" },
      { method: "GET", pattern: "/names", handlerId: "names" },
      { method: "GET", pattern: "/versions", handlerId: "versions" },
      {
        method: "GET",
        pattern: "/api/packages/:name/releases/:version",
        handlerId: "apiRelease",
      },
      { method: "GET", pattern: "/api/packages/:name", handlerId: "apiPackage" },
      { method: "GET", pattern: "/tarballs/:filename", handlerId: "download" },
      { method: "GET", pattern: "/packages/:name", handlerId: "packageResource" },
    ]);
  });

  test("reads use read permission, publish uses write, bearer challenge", () => {
    const adapter = new HexAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    const ctx = hexContext();
    const challenge = adapter.authChallenge({ action: "read" }, ctx);
    expect(challenge.status).toBe(401);
    expect(challenge.header).toContain("Bearer");
  });

  test("advertises the authorization api-key header", () => {
    expect([...new HexAdapter().apiKeyHeaders]).toEqual(["authorization"]);
  });

  test("download permission targets the tarball artifact ref", () => {
    const adapter = new HexAdapter();
    const m = match(
      { method: "GET", pattern: "/tarballs/:filename", handlerId: "download" },
      { filename: "demo-1.2.3.tar" },
      "/tarballs/demo-1.2.3.tar",
    );
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: { type: "artifact", packageName: "demo", artifactRef: "demo@1.2.3" },
    });
  });

  test("package routes target the package permission", () => {
    const adapter = new HexAdapter();
    const m = match(
      { method: "GET", pattern: "/api/packages/:name", handlerId: "apiPackage" },
      { name: "demo" },
      "/api/packages/demo",
    );
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("GET /names lists package names sorted + cacheable", async () => {
    const ctx = hexContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }, { name: "alpha" }];
    const res = await new HexAdapter().handle(
      match({ method: "GET", pattern: "/names", handlerId: "names" }, {}, "/names"),
      new Request("https://registry.test/names"),
      ctx,
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await res.json()).toEqual({ packages: [{ name: "alpha" }, { name: "demo" }] });

    if (!etag) throw new Error("expected ETag");
    const cached = await new HexAdapter().handle(
      match({ method: "GET", pattern: "/names", handlerId: "names" }, {}, "/names"),
      new Request("https://registry.test/names", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /versions lists each package's live versions", async () => {
    const ctx = hexContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [versionRow(storedMeta, "1.0.0"), versionRow(storedMeta, "1.2.3")];
    };
    const res = await new HexAdapter().handle(
      match({ method: "GET", pattern: "/versions", handlerId: "versions" }, {}, "/versions"),
      new Request("https://registry.test/versions"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      packages: [{ name: "demo", versions: ["1.0.0", "1.2.3"] }],
    });
  });

  test("GET /packages/:name returns the release list with checksums + deps", async () => {
    const ctx = hexContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];
    const res = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/packages/:name", handlerId: "packageResource" },
        { name: "demo" },
        "/packages/demo",
      ),
      new Request("https://registry.test/packages/demo"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "demo",
      repository: "private",
      releases: [
        {
          version: "1.2.3",
          checksum: OUTER,
          dependencies: [{ package: "poison", requirement: "~> 1.0" }],
        },
      ],
    });
  });

  test("GET /api/packages/:name assembles meta + release refs", async () => {
    const ctx = hexContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkgRow("demo");
    };
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];
    const res = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/api/packages/:name", handlerId: "apiPackage" },
        { name: "demo" },
        "/api/packages/demo",
      ),
      new Request("https://registry.test/api/packages/demo"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "demo",
      repository: "private",
      meta: { description: "a demo package", licenses: ["MIT"] },
      releases: [
        {
          version: "1.2.3",
          url: "https://registry.example.test/hex/private/api/packages/demo/releases/1.2.3",
          has_docs: false,
        },
      ],
    });
  });

  test("GET /api/packages/:name 404s when unknown", async () => {
    const ctx = hexContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/api/packages/:name", handlerId: "apiPackage" },
        { name: "missing" },
        "/api/packages/missing",
      ),
      new Request("https://registry.test/api/packages/missing"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /api/packages/:name/releases/:version returns release metadata", async () => {
    const ctx = hexContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    const res = await new HexAdapter().handle(
      match(
        {
          method: "GET",
          pattern: "/api/packages/:name/releases/:version",
          handlerId: "apiRelease",
        },
        { name: "demo", version: "1.2.3" },
        "/api/packages/demo/releases/1.2.3",
      ),
      new Request("https://registry.test/api/packages/demo/releases/1.2.3"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.2.3",
      url: "https://registry.example.test/hex/private/tarballs/demo-1.2.3.tar",
      has_docs: false,
      checksum: OUTER,
      inner_checksum: INNER,
      meta: { app: "demo", build_tools: ["mix"] },
      requirements: { poison: { app: "poison", optional: false, requirement: "~> 1.0" } },
      inserted_at: storedMeta.published,
    });
  });

  test("apiRelease 404s when the version is not live", async () => {
    const ctx = hexContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => null;
    const res = await new HexAdapter().handle(
      match(
        {
          method: "GET",
          pattern: "/api/packages/:name/releases/:version",
          handlerId: "apiRelease",
        },
        { name: "demo", version: "9.9.9" },
        "/api/packages/demo/releases/9.9.9",
      ),
      new Request("https://registry.test/api/packages/demo/releases/9.9.9"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /tarballs resolves the stored blob digest for the matching release", async () => {
    const ctx = hexContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("tarball-bytes", { headers: { "content-type": contentType } });
    };
    const res = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/tarballs/:filename", handlerId: "download" },
        { filename: "demo-1.2.3.tar" },
        "/tarballs/demo-1.2.3.tar",
      ),
      new Request("https://registry.test/tarballs/demo-1.2.3.tar"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("tarball-bytes");
  });

  test("download 404s when the release is missing", async () => {
    const ctx = hexContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => null;
    const res = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/tarballs/:filename", handlerId: "download" },
        { filename: "demo-9.9.9.tar" },
        "/tarballs/demo-9.9.9.tar",
      ),
      new Request("https://registry.test/tarballs/demo-9.9.9.tar"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download with an invalid filename throws NAME_INVALID", async () => {
    const ctx = hexContext();
    await expect(
      new HexAdapter().handle(
        match(
          { method: "GET", pattern: "/tarballs/:filename", handlerId: "download" },
          { filename: "Bad-1.0.0.tar" },
          "/tarballs/Bad-1.0.0.tar",
        ),
        new Request("https://registry.test/tarballs/Bad-1.0.0.tar"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("POST /api/publish ingests a tarball and stores derived metadata", async () => {
    const ctx = hexContext();
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

    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: demoHexTarball(),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      url: "https://registry.example.test/hex/private/api/packages/demo/releases/1.2.3",
      package: "demo",
      version: "1.2.3",
    });
    expect(committed.scan).toEqual({
      name: "demo",
      version: "1.2.3",
      mediaType: "application/octet-stream",
    });
    expect(committed.metadata).toMatchObject({
      blobDigest: DIGEST,
      // outerChecksum derives from the stored sha256 digest hex.
      outerChecksum: "a".repeat(64),
      // innerChecksum comes from the tarball CHECKSUM member (b*64).
      innerChecksum: "b".repeat(64),
    });
    expect((committed.metadata as { metadata: { name: string } }).metadata.name).toBe("demo");
  });

  test("POST /publish (alias) also publishes", async () => {
    const ctx = hexContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });
    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/publish", handlerId: "publish" }, {}, "/publish"),
      new Request("https://registry.test/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: demoHexTarball(),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
  });

  test("publish returns 409 when the release already exists", async () => {
    const ctx = hexContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;
    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: demoHexTarball(),
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "release already exists" });
  });

  test("publish rejects a body that is not a Hex tarball with 400", async () => {
    const ctx = hexContext();
    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("publish rejects an empty body with 400", async () => {
    const ctx = hexContext();
    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([]),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("scan.referencedDigests surfaces the stored blob digest", () => {
    const scan = new HexAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ metadata: {} })).toEqual([]);
  });

  test("scan.dependencyGraph maps requirements to a dep map", () => {
    const scan = new HexAdapter().scan;
    expect(scan?.dependencyGraph?.({ metadata: { ...storedMeta } })).toEqual({
      deps: { poison: "~> 1.0" },
      osvEcosystem: "Hex",
      purlType: "hex",
    });
  });
});
