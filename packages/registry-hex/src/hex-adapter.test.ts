import { describe, expect, test } from "bun:test";
import {
  computeDigest,
  digestHex,
  type RegistryPackageRow,
  type RegistryPackageVersionRow,
  type RegistryStoredBlob,
  type RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { HexAdapter } from "./hex-adapter";
import { buildHexTarball, demoHexTarball } from "./hex-tarball.test";
import {
  buildHexVersionMeta,
  HexReleaseMetadataSchema,
  parseHexVersionMeta,
} from "./hex-validation";

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
    requirements: { poison: { requirement: "~> 1.0" } },
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
      { method: "POST", pattern: "/api/packages/:name/releases", handlerId: "publish" },
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

  test("declares no api-key headers (auth flows through the authorization header)", () => {
    expect([...new HexAdapter().apiKeyHeaders]).toEqual([]);
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
          dependencies: [
            {
              package: "poison",
              requirement: "~> 1.0",
              optional: false,
              app: "poison",
              repository: "private",
            },
          ],
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

  test("GET /api/packages/:name keeps meta from the newest release that carries it", async () => {
    const olderMeta = buildHexVersionMeta(
      HexReleaseMetadataSchema.parse({
        name: "demo",
        version: "1.0.0",
        app: "demo",
        description: "a demo package",
        licenses: ["MIT"],
        build_tools: ["mix"],
      }),
      { digest: DIGEST, outerChecksum: OUTER, innerChecksum: INNER },
    );
    // The newer release omits description/licenses; they must not disappear.
    const newerMeta = buildHexVersionMeta(
      HexReleaseMetadataSchema.parse({
        name: "demo",
        version: "1.1.0",
        app: "demo",
        build_tools: ["mix"],
      }),
      { digest: DIGEST, outerChecksum: OUTER, innerChecksum: INNER },
    );
    const ctx = hexContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    // `listLive` is asc (oldest-first): 1.0.0 then 1.1.0.
    ctx.data.versions.listLive = async () => [
      versionRow(olderMeta, "1.0.0"),
      versionRow(newerMeta, "1.1.0"),
    ];
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
          version: "1.0.0",
          url: "https://registry.example.test/hex/private/api/packages/demo/releases/1.0.0",
          has_docs: false,
        },
        {
          version: "1.1.0",
          url: "https://registry.example.test/hex/private/api/packages/demo/releases/1.1.0",
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
      html_url: "https://registry.example.test/hex/private/packages/demo/1.2.3",
      package: "demo",
      version: "1.2.3",
      has_docs: false,
      // outer checksum = sha256 of the stored tarball (digest hex).
      checksum: "a".repeat(64),
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

  test("POST /api/packages/:name/releases (mix hex.publish endpoint) publishes", async () => {
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
      match(
        { method: "POST", pattern: "/api/packages/:name/releases", handlerId: "publish" },
        { name: "demo" },
        "/api/packages/demo/releases",
      ),
      new Request("https://registry.test/api/packages/demo/releases", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: demoHexTarball(),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version: string }).version).toBe("1.2.3");
  });

  test("publish -> read: outer_checksum advertised == sha256 of the served tarball bytes", async () => {
    // The integrity invariant `mix deps.get` verifies: the checksum in
    // /packages/:name and the api-release must equal sha256 of the exact bytes the
    // download route serves. Drive a real tarball through publish, then read it
    // back through the package/release/download handlers with NO hardcoded
    // checksums — the store returns the real digest of the bytes.
    const tarball = demoHexTarball();
    const realDigest = computeDigest(tarball); // sha256:<hex> of the exact bytes
    const expectedChecksum = digestHex(realDigest);

    // 1) Publish: capture the metadata the adapter persists.
    let committedMetadata: Record<string, unknown> = {};
    const pubCtx = hexContext();
    pubCtx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    pubCtx.data.versions.exists = async () => false;
    pubCtx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: realDigest,
      size: tarball.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    pubCtx.data.versions.commitOrReleaseBlob = async (input) => {
      committedMetadata = input.metadata;
      return { versionId: "ver_1" };
    };
    const pubRes = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: tarball,
      }),
      pubCtx,
    );
    expect(pubRes.status).toBe(201);
    expect(((await pubRes.json()) as { checksum: string }).checksum).toBe(expectedChecksum);

    // 2) Read back through /packages/:name with the persisted metadata + a store
    //    that serves the exact published bytes.
    const readCtx = hexContext();
    readCtx.data.packages.findByName = async () => pkgRow("demo");
    readCtx.data.versions.listLive = async () => [versionRow(committedMetadata)];
    readCtx.data.versions.findLive = async () => versionRow(committedMetadata);
    readCtx.data.content.blobRefExists = async () => true;
    readCtx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      expect(digest).toBe(realDigest);
      return new Response(tarball, { headers: { "content-type": contentType } });
    };

    const pkgRes = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/packages/:name", handlerId: "packageResource" },
        { name: "demo" },
        "/packages/demo",
      ),
      new Request("https://registry.test/packages/demo"),
      readCtx,
    );
    const pkgBody = (await pkgRes.json()) as {
      releases: { checksum: string }[];
    };
    const advertised = pkgBody.releases[0]?.checksum;

    // 3) The /tarballs download bytes hashed must equal the advertised checksum.
    const dlRes = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/tarballs/:filename", handlerId: "download" },
        { filename: "demo-1.2.3.tar" },
        "/tarballs/demo-1.2.3.tar",
      ),
      new Request("https://registry.test/tarballs/demo-1.2.3.tar"),
      readCtx,
    );
    const servedBytes = new Uint8Array(await dlRes.arrayBuffer());
    expect(advertised).toBe(digestHex(computeDigest(servedBytes)));
    expect(advertised).toBe(expectedChecksum);

    // The api-release surfaces the same outer checksum + the inner checksum from
    // the tarball CHECKSUM member (lowercased).
    const relRes = await new HexAdapter().handle(
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
      readCtx,
    );
    const relBody = (await relRes.json()) as { checksum: string; inner_checksum: string };
    expect(relBody.checksum).toBe(expectedChecksum);
    expect(relBody.inner_checksum).toBe("b".repeat(64));
  });

  test("publish derives inner_checksum from the outer digest when CHECKSUM is absent", async () => {
    // Older-format tarballs omit the CHECKSUM member; inner_checksum must fall
    // back to the outer digest hex (and still pass the stored-meta schema).
    const enc = (s: string) => new TextEncoder().encode(s);
    const metadataConfig = [
      '{<<"name">>,<<"demo">>}.',
      '{<<"app">>,<<"demo">>}.',
      '{<<"version">>,<<"1.2.3">>}.',
    ].join("\n");
    const tarball = buildHexTarball([
      { name: "VERSION", data: enc("3") },
      { name: "metadata.config", data: enc(metadataConfig) },
    ]);
    const realDigest = computeDigest(tarball);

    let committed: Record<string, unknown> = {};
    const ctx = hexContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: realDigest,
      size: tarball.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed = input.metadata;
      return { versionId: "ver_1" };
    };
    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: tarball,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(committed.innerChecksum).toBe(digestHex(realDigest));
    expect(committed.outerChecksum).toBe(digestHex(realDigest));
    // The stored meta must still validate against the version-meta schema.
    expect(parseHexVersionMeta(committed)).not.toBeNull();
  });

  test("publish carries optional/app from requirements into /packages/:name deps", async () => {
    // The demo tarball's `poison` requirement carries {optional:false, app:poison};
    // the package resource must emit the real Dependency shape, not force defaults.
    let committed: Record<string, unknown> = {};
    const pubCtx = hexContext();
    pubCtx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    pubCtx.data.versions.exists = async () => false;
    pubCtx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    pubCtx.data.versions.commitOrReleaseBlob = async (input) => {
      committed = input.metadata;
      return { versionId: "ver_1" };
    };
    await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: demoHexTarball(),
      }),
      pubCtx,
    );

    const readCtx = hexContext();
    readCtx.data.packages.findByName = async () => pkgRow("demo");
    readCtx.data.versions.listLive = async () => [versionRow(committed)];
    const res = await new HexAdapter().handle(
      match(
        { method: "GET", pattern: "/packages/:name", handlerId: "packageResource" },
        { name: "demo" },
        "/packages/demo",
      ),
      new Request("https://registry.test/packages/demo"),
      readCtx,
    );
    const body = (await res.json()) as { releases: { dependencies: unknown[] }[] };
    expect(body.releases[0]?.dependencies).toEqual([
      {
        package: "poison",
        requirement: "~> 1.0",
        optional: false,
        app: "poison",
        repository: "private",
      },
    ]);
  });

  test("publish rejects a metadata.config that overflows the parser depth (400 not 500)", async () => {
    // A deeply nested metadata.config must yield a clean 400, never an uncaught
    // RangeError surfacing as a 500.
    const enc = (s: string) => new TextEncoder().encode(s);
    const deep = `{<<"licenses">>,${"[".repeat(20000)}${"]".repeat(20000)}}.`;
    const tarball = buildHexTarball([
      { name: "VERSION", data: enc("3") },
      { name: "metadata.config", data: enc(deep) },
    ]);
    const ctx = hexContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    const res = await new HexAdapter().handle(
      match({ method: "POST", pattern: "/api/publish", handlerId: "publish" }, {}, "/api/publish"),
      new Request("https://registry.test/api/publish", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: tarball,
      }),
      ctx,
    );
    // metadata.config has no valid name/version/app -> 400 (and crucially no throw).
    expect(res.status).toBe(400);
  });
});
