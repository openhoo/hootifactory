/**
 * End-to-end protocol round-trip over an in-memory data service: publish a
 * rockspec + a source rock with real bytes, then read the regenerated
 * `/manifest` and download both artifacts back, asserting the served bytes are
 * exactly what was published (addressed by their content digest). This exercises
 * the real publish -> index -> download path instead of per-call stubs.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  computeDigest,
  type RegistryDataService,
  type RegistryPackageRow,
  type RegistryPackageVersionRow,
  type RegistryRequestContext,
  type RegistryStoredBlob,
  type RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { LuarocksAdapter } from "./luarocks-adapter";

const ROCKSPEC_TEXT = `package = "demo"
version = "1.0.0-1"
source = { url = "https://example.test/demo-1.0.0.tar.gz" }
description = { summary = "demo rock", license = "MIT" }
dependencies = { "lua >= 5.1" }
build = { type = "builtin" }
`;
const ROCKSPEC_BYTES = new TextEncoder().encode(ROCKSPEC_TEXT);
const ROCK_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]); // zip-ish bytes

/** A minimal in-memory store backing the data-service overlay. */
interface Store {
  blobs: Map<string, Uint8Array>;
  packages: Map<string, RegistryPackageRow>;
  versions: Map<string, RegistryPackageVersionRow>;
  seq: number;
}

function inMemoryContext(): { ctx: RegistryRequestContext; store: Store } {
  const store: Store = { blobs: new Map(), packages: new Map(), versions: new Map(), seq: 0 };
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "luarocks", mountPath: "acme/luarocks" };

  const data = ctx.data as RegistryDataService;

  data.packages.findByName = async (name) => store.packages.get(name) ?? null;
  data.packages.findOrCreate = async ({ name }) => {
    const existing = store.packages.get(name);
    if (existing) return existing;
    const row: RegistryPackageRow = {
      id: `pkg_${name}`,
      orgId: "org_1",
      repositoryId: "repo_1",
      name,
      namespace: null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.packages.set(name, row);
    return row;
  };
  data.packages.listNames = async () => [...store.packages.keys()].map((name) => ({ name }));

  const versionKey = (pkgName: string, version: string) => `${pkgName}@${version}`;
  data.versions.findLive = async (pkg, version) =>
    store.versions.get(versionKey(pkg.name, version)) ?? null;
  data.versions.listLive = async (pkg) =>
    [...store.versions.values()].filter((row) => row.packageId === pkg.id && !row.deletedAt);
  data.versions.create = async (input) => {
    const key = versionKey(input.package.name, input.version);
    if (store.versions.has(key)) return null;
    const id = `ver_${++store.seq}`;
    store.versions.set(key, {
      id,
      orgId: "org_1",
      packageId: input.package.id,
      version: input.version,
      metadata: input.metadata,
      sizeBytes: input.sizeBytes,
      publishedByUserId: null,
      publishedByTokenId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  };
  data.versions.patch = async (input) => {
    const key = versionKey(input.package.name, input.version);
    const row = store.versions.get(key);
    const result = input.patch(
      row ? { id: row.id, metadata: row.metadata, deletedAt: row.deletedAt } : null,
    );
    if (result.update && row) {
      store.versions.set(key, {
        ...row,
        metadata: result.update.metadata,
        sizeBytes: result.update.sizeBytes ?? row.sizeBytes,
      });
    }
    return result.result;
  };

  data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
    const digest = computeDigest(input.data);
    const deduped = store.blobs.has(digest);
    store.blobs.set(digest, input.data);
    return {
      digest,
      size: input.data.byteLength,
      deduped,
      refCreated: !deduped,
      blobRefId: digest,
    };
  };
  data.content.releaseBlobRef = async () => {};
  data.content.blobRefExists = async ({ digest }) => store.blobs.has(digest);
  data.content.serveBlobIfClean = async ({ digest, contentType }) => {
    const bytes = store.blobs.get(digest);
    if (!bytes) return new Response("missing", { status: 404 });
    return new Response(bytes, { headers: { "content-type": contentType } });
  };

  data.assets.upsert = async (input) =>
    ({
      id: `asset_${++store.seq}`,
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
    }) satisfies Awaited<ReturnType<typeof data.assets.upsert>>;

  return { ctx, store };
}

function putMatch(filename: string): RouteMatch {
  return {
    entry: { method: "PUT", pattern: "/:filename", handlerId: "publish" },
    params: { filename },
    path: `/${filename}`,
  };
}
function getMatch(filename: string): RouteMatch {
  return {
    entry: { method: "GET", pattern: "/:filename", handlerId: "download" },
    params: { filename },
    path: `/${filename}`,
  };
}

describe("LuaRocks publish -> manifest -> download round-trip", () => {
  let adapter: LuarocksAdapter;
  let ctx: RegistryRequestContext;
  let store: Store;

  beforeEach(() => {
    adapter = new LuarocksAdapter();
    ({ ctx, store } = inMemoryContext());
  });

  async function publish(filename: string, bytes: Uint8Array) {
    return adapter.handle(
      putMatch(filename),
      new Request(`https://registry.test/${filename}`, { method: "PUT", body: bytes }),
      ctx,
    );
  }

  test("publishes a rockspec + src rock, indexes them, and serves the exact bytes back", async () => {
    // 1. Publish the rockspec, then the source rock, onto one version.
    expect((await publish("demo-1.0.0-1.rockspec", ROCKSPEC_BYTES)).status).toBe(201);
    expect((await publish("demo-1.0.0-1.src.rock", ROCK_BYTES)).status).toBe(201);

    // Both blobs are stored under their real content digests.
    expect(store.blobs.has(computeDigest(ROCKSPEC_BYTES))).toBe(true);
    expect(store.blobs.has(computeDigest(ROCK_BYTES))).toBe(true);

    // 2. The regenerated manifest advertises the rock, version, both archs, and
    // the parsed dependency.
    const manifestRes = await adapter.handle(
      {
        entry: { method: "GET", pattern: "/manifest", handlerId: "manifest" },
        params: {},
        path: "/manifest",
      },
      new Request("https://registry.test/manifest"),
      ctx,
    );
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.text();
    expect(manifest).toContain("repository = {");
    expect(manifest).toContain("demo = {");
    expect(manifest).toContain('["1.0.0-1"]');
    expect(manifest).toContain('arch = "rockspec"');
    expect(manifest).toContain('arch = "src"');
    expect(manifest).toContain('"lua >= 5.1"');

    // 3. Download each artifact and assert the served bytes match what we
    // published (i.e. the digest-addressed blob round-trips intact).
    const rockspecDl = await adapter.handle(
      getMatch("demo-1.0.0-1.rockspec"),
      new Request("https://registry.test/demo-1.0.0-1.rockspec"),
      ctx,
    );
    expect(rockspecDl.status).toBe(200);
    expect(new Uint8Array(await rockspecDl.arrayBuffer())).toEqual(ROCKSPEC_BYTES);

    const rockDl = await adapter.handle(
      getMatch("demo-1.0.0-1.src.rock"),
      new Request("https://registry.test/demo-1.0.0-1.src.rock"),
      ctx,
    );
    expect(rockDl.status).toBe(200);
    expect(new Uint8Array(await rockDl.arrayBuffer())).toEqual(ROCK_BYTES);
  });

  test("upload API round-trip: check_rockspec -> upload -> upload_rock serves both artifacts", async () => {
    // check_rockspec on a fresh module: both module and version are false.
    const checkRes = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/1/:apikey/check_rockspec",
          handlerId: "apiCheckRockspec",
        },
        params: { apikey: "tok" },
        path: "/api/1/tok/check_rockspec",
      },
      new Request("https://registry.test/api/1/tok/check_rockspec?package=demo&version=1.0.0-1"),
      ctx,
    );
    const check = (await checkRes.json()) as { module: unknown; version: unknown };
    expect(check.module).toBe(false);
    expect(check.version).toBe(false);

    // upload the rockspec.
    const rockspecForm = new FormData();
    rockspecForm.append("rockspec_file", new Blob([ROCKSPEC_BYTES]), "demo-1.0.0-1.rockspec");
    const uploadRes = await adapter.handle(
      {
        entry: { method: "POST", pattern: "/api/1/:apikey/upload", handlerId: "apiUpload" },
        params: { apikey: "tok" },
        path: "/api/1/tok/upload",
      },
      new Request("https://registry.test/api/1/tok/upload", { method: "POST", body: rockspecForm }),
      ctx,
    );
    expect(uploadRes.status).toBe(200);
    const upload = (await uploadRes.json()) as { is_new: boolean; version: { id: number } };
    expect(upload.is_new).toBe(true);

    // upload_rock attaches the source rock to the same version.
    const rockForm = new FormData();
    rockForm.append("rock_file", new Blob([ROCK_BYTES]), "demo.src.rock");
    const rockRes = await adapter.handle(
      {
        entry: {
          method: "POST",
          pattern: "/api/1/:apikey/upload_rock/:versionId",
          handlerId: "apiUploadRock",
        },
        params: { apikey: "tok", versionId: String(upload.version.id) },
        path: `/api/1/tok/upload_rock/${upload.version.id}`,
      },
      new Request(`https://registry.test/api/1/tok/upload_rock/${upload.version.id}`, {
        method: "POST",
        body: rockForm,
      }),
      ctx,
    );
    expect(rockRes.status).toBe(200);

    // Both artifacts are now downloadable with their exact bytes.
    const rockDl = await adapter.handle(
      getMatch("demo-1.0.0-1.src.rock"),
      new Request("https://registry.test/demo-1.0.0-1.src.rock"),
      ctx,
    );
    expect(rockDl.status).toBe(200);
    expect(new Uint8Array(await rockDl.arrayBuffer())).toEqual(ROCK_BYTES);

    // A second check_rockspec now reports the module + revision as existing.
    const checkAgain = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/1/:apikey/check_rockspec",
          handlerId: "apiCheckRockspec",
        },
        params: { apikey: "tok" },
        path: "/api/1/tok/check_rockspec",
      },
      new Request("https://registry.test/api/1/tok/check_rockspec?package=demo&version=1.0.0-1"),
      ctx,
    );
    const after = (await checkAgain.json()) as { module: unknown; version: unknown };
    expect(after.module).toBe("demo");
    expect(after.version).toEqual({ version: "1.0.0-1" });
  });
});
