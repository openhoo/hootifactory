import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { LuarocksAdapter } from "./luarocks-adapter";
import { LuarocksVersionMetaSchema } from "./luarocks-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: "1.0.0-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  metadata: Record<string, unknown>,
  version = "1.0.0-1",
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

const storedMeta = LuarocksVersionMetaSchema.parse({
  rock: "demo",
  version: "1.0.0-1",
  summary: "demo rock",
  dependencies: ["lua >= 5.1"],
  blobs: {
    rockspec: { digest: DIGEST, filename: "demo-1.0.0-1.rockspec", sizeBytes: 10 },
    src: { digest: DIGEST, filename: "demo-1.0.0-1.src.rock", sizeBytes: 20 },
  },
});

function luarocksContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "luarocks", mountPath: "luarocks/private" };
  return ctx;
}

const ROCKSPEC_TEXT = `package = "demo"
version = "1.0.0-1"
source = { url = "https://example.test/demo-1.0.0.tar.gz" }
description = { summary = "demo rock", license = "MIT" }
dependencies = { "lua >= 5.1" }
build = { type = "builtin" }
`;

describe("LuaRocks adapter", () => {
  test("declares manifest, api-upload, download and publish routes (literals first)", () => {
    expect(new LuarocksAdapter().routes()).toEqual([
      { method: "GET", pattern: "/manifest", handlerId: "manifest" },
      { method: "GET", pattern: "/manifest-5.1", handlerId: "manifest" },
      { method: "GET", pattern: "/manifest-5.2", handlerId: "manifest" },
      { method: "GET", pattern: "/manifest-5.3", handlerId: "manifest" },
      { method: "GET", pattern: "/manifest-5.4", handlerId: "manifest" },
      { method: "POST", pattern: "/api/1/:apikey/upload", handlerId: "apiUpload" },
      { method: "GET", pattern: "/:filename", handlerId: "download" },
      { method: "PUT", pattern: "/:filename", handlerId: "publish" },
    ]);
  });

  test("uses read for GET, write for PUT/POST, and basic auth", () => {
    const adapter = new LuarocksAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("declares proxyable + virtualizable capabilities", () => {
    const caps = new LuarocksAdapter().capabilities;
    expect(caps.proxyable).toBe(true);
    expect(caps.virtualizable).toBe(true);
    expect(caps.contentAddressable).toBe(false);
    expect(caps.resumableUploads).toBe(false);
  });

  test("download permission targets the rock package", () => {
    const adapter = new LuarocksAdapter();
    const match = {
      entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
      params: { filename: "demo-1.0.0-1.src.rock" },
      path: "/demo-1.0.0-1.src.rock",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("GET /manifest emits a Lua-table manifest over live versions", async () => {
    const ctx = luarocksContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }, { name: "alpha" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (row) => {
      if (row.name === "alpha") {
        return [
          versionRow(
            LuarocksVersionMetaSchema.parse({
              rock: "alpha",
              version: "2.0.0-1",
              blobs: {
                rockspec: { digest: DIGEST, filename: "alpha-2.0.0-1.rockspec", sizeBytes: 5 },
              },
            }),
            "2.0.0-1",
          ),
        ];
      }
      return [versionRow(storedMeta)];
    };

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/manifest", handlerId: "manifest" },
        params: {},
        path: "/manifest",
      },
      new Request("https://registry.test/manifest"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-lua");
    expect(res.headers.get("etag")).toBeTruthy();
    const body = await res.text();
    expect(body).toContain("repository = {");
    expect(body).toContain("alpha = {");
    expect(body).toContain("demo = {");
    expect(body).toContain('["1.0.0-1"]');
    expect(body).toContain('arch = "rockspec"');
    expect(body).toContain('arch = "src"');
    expect(body).toContain('"lua >= 5.1"');
    expect(body).toContain("commands = {}");
  });

  test("versioned manifest endpoint shares the manifest handler", async () => {
    const ctx = luarocksContext();
    ctx.data.packages.listNames = async () => [];
    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/manifest-5.4", handlerId: "manifest" },
        params: {},
        path: "/manifest-5.4",
      },
      new Request("https://registry.test/manifest-5.4"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("repository = {}\nmodules = {}\ncommands = {}\n");
  });

  test("GET /manifest is cacheable via ETag", async () => {
    const ctx = luarocksContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }];
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const first = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/manifest", handlerId: "manifest" },
        params: {},
        path: "/manifest",
      },
      new Request("https://registry.test/manifest"),
      ctx,
    );
    const etag = first.headers.get("etag");
    if (!etag) throw new Error("expected ETag");
    const cached = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/manifest", handlerId: "manifest" },
        params: {},
        path: "/manifest",
      },
      new Request("https://registry.test/manifest", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /<rock>-<version>.<arch>.rock serves the stored blob", async () => {
    const ctx = luarocksContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkgRow("demo");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.0.0-1");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("rock-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
        params: { filename: "demo-1.0.0-1.src.rock" },
        path: "/demo-1.0.0-1.src.rock",
      },
      new Request("https://registry.test/demo-1.0.0-1.src.rock"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("rock-bytes");
  });

  test("GET a rockspec serves the rockspec blob", async () => {
    const ctx = luarocksContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ contentType }) =>
      new Response("spec", { headers: { "content-type": contentType } });

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
        params: { filename: "demo-1.0.0-1.rockspec" },
        path: "/demo-1.0.0-1.rockspec",
      },
      new Request("https://registry.test/demo-1.0.0-1.rockspec"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spec");
  });

  test("download 404s for an unknown rock", async () => {
    const ctx = luarocksContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
        params: { filename: "missing-1.0.0-1.src.rock" },
        path: "/missing-1.0.0-1.src.rock",
      },
      new Request("https://registry.test/missing-1.0.0-1.src.rock"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download 404s when the requested filename does not match the stored arch", async () => {
    const ctx = luarocksContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
        // arch present in metadata but a different (spoofed) filename.
        params: { filename: "demo-1.0.0-1.linux-x86_64.rock" },
        path: "/demo-1.0.0-1.linux-x86_64.rock",
      },
      new Request("https://registry.test/demo-1.0.0-1.linux-x86_64.rock"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download throws notFound for an unparseable filename", async () => {
    const ctx = luarocksContext();
    await expect(
      new LuarocksAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
          params: { filename: "not-an-artifact.txt" },
          path: "/not-an-artifact.txt",
        },
        new Request("https://registry.test/not-an-artifact.txt"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("PUT a rockspec publishes a new version with parsed dependencies", async () => {
    const ctx = luarocksContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: ROCKSPEC_TEXT.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.create = async (input) => {
      committed.metadata = input.metadata;
      return "ver_1";
    };
    ctx.data.assets.upsert = async (input) => ({
      id: "asset_1",
      orgId: "org_1",
      repositoryId: "repo_1",
      packageId: input.package?.id ?? null,
      packageVersionId: input.packageVersion?.id ?? null,
      blobRefId: input.blobRefId ?? null,
      role: input.role,
      scope: input.scope ?? "",
      path: input.path ?? null,
      digest: input.digest,
      mediaType: input.mediaType ?? null,
      sizeBytes: input.sizeBytes ?? 0,
      metadata: input.metadata ?? {},
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const scanned: { digest?: string } = {};
    ctx.enqueueScan = async (input) => {
      scanned.digest = input.digest;
    };

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:filename", handlerId: "publish" },
        params: { filename: "demo-1.0.0-1.rockspec" },
        path: "/demo-1.0.0-1.rockspec",
      },
      new Request("https://registry.test/demo-1.0.0-1.rockspec", {
        method: "PUT",
        body: ROCKSPEC_TEXT,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      rock: "demo",
      version: "1.0.0-1",
      arch: "rockspec",
      filename: "demo-1.0.0-1.rockspec",
    });
    expect(scanned.digest).toBe(DIGEST);
    expect(committed.metadata).toMatchObject({
      rock: "demo",
      version: "1.0.0-1",
      summary: "demo rock",
      license: "MIT",
      dependencies: ["lua >= 5.1"],
    });
    const blobs = (committed.metadata as { blobs: Record<string, { filename: string }> }).blobs;
    expect(blobs.rockspec?.filename).toBe("demo-1.0.0-1.rockspec");
  });

  test("PUT a rock merges an arch into an existing version", async () => {
    const ctx = luarocksContext();
    const patched: { metadata?: Record<string, unknown> } = {};
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 8,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_2",
    });
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    // create returns null => version already exists, fall through to patch.
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async (input) => {
      const existing = LuarocksVersionMetaSchema.parse({
        rock: "demo",
        version: "1.0.0-1",
        dependencies: ["lua >= 5.1"],
        blobs: {
          rockspec: { digest: DIGEST, filename: "demo-1.0.0-1.rockspec", sizeBytes: 10 },
        },
      });
      const result = input.patch({ id: "ver_1", metadata: existing, deletedAt: null });
      if (result.update) patched.metadata = result.update.metadata;
      return result.result;
    };
    ctx.data.assets.upsert = async () => ({}) as Awaited<ReturnType<typeof ctx.data.assets.upsert>>;

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:filename", handlerId: "publish" },
        params: { filename: "demo-1.0.0-1.linux-x86_64.rock" },
        path: "/demo-1.0.0-1.linux-x86_64.rock",
      },
      new Request("https://registry.test/demo-1.0.0-1.linux-x86_64.rock", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    const blobs = (patched.metadata as { blobs: Record<string, unknown> }).blobs;
    expect(Object.keys(blobs).sort()).toEqual(["linux-x86_64", "rockspec"]);
  });

  test("PUT a duplicate arch returns 409 and releases the new blob ref", async () => {
    const ctx = luarocksContext();
    const released: { digest?: string } = {};
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 8,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_3",
    });
    ctx.data.content.releaseBlobRef = async ({ digest }) => {
      released.digest = digest;
    };
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async (input) => {
      const existing = LuarocksVersionMetaSchema.parse({
        rock: "demo",
        version: "1.0.0-1",
        blobs: {
          "linux-x86_64": {
            digest: DIGEST,
            filename: "demo-1.0.0-1.linux-x86_64.rock",
            sizeBytes: 8,
          },
        },
      });
      return input.patch({ id: "ver_1", metadata: existing, deletedAt: null }).result;
    };

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:filename", handlerId: "publish" },
        params: { filename: "demo-1.0.0-1.linux-x86_64.rock" },
        path: "/demo-1.0.0-1.linux-x86_64.rock",
      },
      new Request("https://registry.test/demo-1.0.0-1.linux-x86_64.rock", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(released.digest).toBe(DIGEST);
  });

  test("PUT a rockspec whose package/version disagrees with the filename is rejected", async () => {
    const ctx = luarocksContext();
    let stored = false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => {
      stored = true;
      return { digest: DIGEST, size: 1, deduped: false, refCreated: true, blobRefId: "ref_x" };
    };
    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:filename", handlerId: "publish" },
        params: { filename: "demo-9.9.9-1.rockspec" },
        path: "/demo-9.9.9-1.rockspec",
      },
      new Request("https://registry.test/demo-9.9.9-1.rockspec", {
        method: "PUT",
        body: ROCKSPEC_TEXT,
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    // The blob is never stored when the rockspec fails validation.
    expect(stored).toBe(false);
  });

  test("PUT an unsupported filename is rejected with 400", async () => {
    const ctx = luarocksContext();
    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:filename", handlerId: "publish" },
        params: { filename: "demo-1.0.0-1.tar.gz" },
        path: "/demo-1.0.0-1.tar.gz",
      },
      new Request("https://registry.test/demo-1.0.0-1.tar.gz", {
        method: "PUT",
        body: new Uint8Array([1]),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/1/:key/upload publishes the rockspec from a multipart part", async () => {
    const ctx = luarocksContext();
    const committed: { metadata?: Record<string, unknown> } = {};
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: ROCKSPEC_TEXT.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_api",
    });
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.create = async (input) => {
      committed.metadata = input.metadata;
      return "ver_api";
    };
    ctx.data.assets.upsert = async () => ({}) as Awaited<ReturnType<typeof ctx.data.assets.upsert>>;

    const form = new FormData();
    form.append("rockspec_file", new Blob([ROCKSPEC_TEXT]), "demo-1.0.0-1.rockspec");

    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "POST", pattern: "/api/1/:apikey/upload", handlerId: "apiUpload" },
        params: { apikey: "secret" },
        path: "/api/1/secret/upload",
      },
      new Request("https://registry.test/api/1/secret/upload", { method: "POST", body: form }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, rock: "demo", version: "1.0.0-1" });
    expect(committed.metadata).toMatchObject({ rock: "demo", version: "1.0.0-1" });
  });

  test("POST /api upload rejects a missing rockspec_file part", async () => {
    const ctx = luarocksContext();
    const form = new FormData();
    form.append("other", "x");
    const res = await new LuarocksAdapter().handle(
      {
        entry: { method: "POST", pattern: "/api/1/:apikey/upload", handlerId: "apiUpload" },
        params: { apikey: "secret" },
        path: "/api/1/secret/upload",
      },
      new Request("https://registry.test/api/1/secret/upload", { method: "POST", body: form }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("scan.referencedDigests surfaces all stored blob digests", () => {
    const scan = new LuarocksAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST, DIGEST]);
    expect(scan?.referencedDigests?.({ rock: "demo" })).toEqual([]);
  });
});
