import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "../testing";
import {
  bytesResponseWithEtag,
  immutableRegistryBlobCacheControl,
  jsonResponseWithEtag,
  readBoundedBytes,
  repoResponseCache,
  serveAssetBlob,
  serveRegistryBlob,
  serveVersionBlob,
  textResponseWithEtag,
} from "./helpers";

describe("registry SDK helpers", () => {
  test("textResponseWithEtag emits validators and honors conditional requests", async () => {
    const first = textResponseWithEtag(new Request("https://registry.test/index"), "hello", {
      "content-type": "text/plain",
    });
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe("text/plain");
    await expect(first.text()).resolves.toBe("hello");

    const cached = textResponseWithEtag(
      new Request("https://registry.test/index", {
        headers: { "if-none-match": `W/${etag}` },
      }),
      "hello",
      { "content-type": "text/plain" },
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });

  test("bytesResponseWithEtag emits validators and honors conditional requests", async () => {
    const body = new TextEncoder().encode("hello");
    const first = bytesResponseWithEtag(new Request("https://registry.test/index.gz"), body, {
      "content-type": "application/gzip",
    });
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe("application/gzip");
    expect(await first.bytes()).toEqual(body);

    const cached = bytesResponseWithEtag(
      new Request("https://registry.test/index.gz", {
        headers: { "if-none-match": etag },
      }),
      body,
      { "content-type": "application/gzip" },
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });

  test("jsonResponseWithEtag stringifies JSON and honors conditional requests", async () => {
    const first = jsonResponseWithEtag(new Request("https://registry.test/index.json"), {
      ok: true,
      entries: ["a", "b"],
    });
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(first.json()).resolves.toEqual({ ok: true, entries: ["a", "b"] });

    const cached = jsonResponseWithEtag(
      new Request("https://registry.test/index.json", {
        headers: { "if-none-match": etag },
      }),
      { ok: true, entries: ["a", "b"] },
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });

  test("serveRegistryBlob returns the caller's missing response when the blob is absent", async () => {
    const ctx = createTestRegistryContext();

    const res = await serveRegistryBlob(ctx, {
      digest: "sha256:missing",
      kind: "generic_file",
      scope: "missing",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked", { status: 403 }),
      missing: () => new Response("missing", { status: 404 }),
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing");
  });

  test("serveRegistryBlob delegates clean blob responses to the data service", async () => {
    const ctx = createTestRegistryContext({
      data: {
        ...createTestRegistryContext().data,
        content: {
          ...createTestRegistryContext().data.content,
          blobRefExists: () => Promise.resolve(true),
        },
      },
    });

    const res = await serveRegistryBlob(ctx, {
      digest: "sha256:present",
      kind: "generic_file",
      scope: "present",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked", { status: 403 }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("blob:sha256:present");
  });

  test("serveRegistryBlob can own ETag conditional handling and default block response", async () => {
    const ctx = createTestRegistryContext({
      data: {
        ...createTestRegistryContext().data,
        content: {
          ...createTestRegistryContext().data.content,
          blobRefExists: () => Promise.resolve(true),
          serveBlobIfClean: (opts) =>
            Promise.resolve(
              opts.notModified?.() ??
                opts.blocked?.() ??
                new Response("served", { headers: opts.extraHeaders }),
            ),
        },
      },
    });

    const res = await serveRegistryBlob(ctx, {
      digest: "sha256:present",
      kind: "generic_file",
      scope: "present",
      contentType: "application/octet-stream",
      req: new Request("https://registry.test/blob", {
        headers: { "if-none-match": '"abc"' },
      }),
      etag: '"abc"',
    });

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"abc"');
  });

  test("serveAssetBlob resolves scoped assets before serving bytes", async () => {
    const base = createTestRegistryContext();
    const ctx = createTestRegistryContext({
      data: {
        ...base.data,
        assets: {
          ...base.data.assets,
          findByScope: () =>
            Promise.resolve({
              id: "asset_1",
              orgId: "org_1",
              repositoryId: "repo_1",
              packageId: null,
              packageVersionId: null,
              blobRefId: "ref_1",
              digest: "sha256:asset",
              role: "download",
              scope: "pkg/1.0.0",
              path: null,
              mediaType: "application/gzip",
              sizeBytes: 5,
              metadata: {},
              deletedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
        },
        content: {
          ...base.data.content,
          blobRefExists: () => Promise.resolve(true),
        },
      },
    });

    const res = await serveAssetBlob(ctx, {
      role: "download",
      scope: "pkg/1.0.0",
      kind: "tarball",
    });

    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(await res.text()).toBe("blob:sha256:asset");
  });

  test("serveVersionBlob resolves package and live version before serving bytes", async () => {
    const base = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: "org_1",
      repositoryId: "repo_1",
      name: "pkg",
      namespace: null,
      metadata: {},
      latestVersion: "1.0.0",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const ctx = createTestRegistryContext({
      data: {
        ...base.data,
        packages: { ...base.data.packages, findByName: () => Promise.resolve(pkg) },
        versions: {
          ...base.data.versions,
          findLive: () =>
            Promise.resolve({
              id: "ver_1",
              orgId: "org_1",
              packageId: "pkg_1",
              version: "1.0.0",
              metadata: { digest: "sha256:version", mediaType: "application/zip" },
              sizeBytes: 5,
              publishedByUserId: null,
              publishedByTokenId: null,
              deletedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
        },
        content: {
          ...base.data.content,
          blobRefExists: () => Promise.resolve(true),
        },
      },
    });

    const res = await serveVersionBlob<{
      digest: string;
      mediaType: string;
    }>(ctx, {
      name: "pkg",
      version: "1.0.0",
      kind: "archive",
      scope: "pkg/1.0.0",
      parseMetadata: (value) =>
        value && typeof value === "object" && "digest" in value && "mediaType" in value
          ? (value as { digest: string; mediaType: string })
          : null,
      digest: ({ metadata }) => metadata.digest,
      contentType: ({ metadata }) => metadata.mediaType,
    });

    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(await res.text()).toBe("blob:sha256:version");
  });

  test("readBoundedBytes enforces declared and streamed byte caps while hashing", async () => {
    await expect(
      readBoundedBytes(new Response("too large", { headers: { "content-length": "100" } }), 5),
    ).resolves.toBeNull();

    const body = new TextEncoder().encode("hello");
    const read = await readBoundedBytes(new Response(body), 5, {
      digests: ["md5", "sha1", "sha256"],
    });

    expect(read?.bytes).toEqual(body);
    expect(read?.digests.md5).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(read?.digests.sha1).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(read?.digests.sha256).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("repoResponseCache scopes entries by repository and can clear one repo", async () => {
    const cache = repoResponseCache<string>();
    const repoA = createTestRegistryContext();
    const repoB = createTestRegistryContext({
      repo: { ...createTestRegistryContext().repo, id: "repo_2" },
    });
    let loads = 0;

    await expect(
      cache.get(repoA, "index", () => ({ body: `a:${++loads}`, etag: '"a"' })),
    ).resolves.toEqual({ body: "a:1", etag: '"a"' });
    await expect(
      cache.get(repoA, "index", () => ({ body: `a:${++loads}`, etag: '"a"' })),
    ).resolves.toEqual({ body: "a:1", etag: '"a"' });
    await expect(
      cache.get(repoB, "index", () => ({ body: `b:${++loads}`, etag: '"b"' })),
    ).resolves.toEqual({ body: "b:2", etag: '"b"' });

    cache.clear(repoA);
    await expect(
      cache.get(repoA, "index", () => ({ body: `a:${++loads}`, etag: '"a2"' })),
    ).resolves.toEqual({ body: "a:3", etag: '"a2"' });
    await expect(
      cache.get(repoB, "index", () => ({ body: `b:${++loads}`, etag: '"b"' })),
    ).resolves.toEqual({ body: "b:2", etag: '"b"' });
  });

  test("immutable blob cache control is public only for anonymous public repos", () => {
    const anonymousPublic = createTestRegistryContext({
      repo: { ...createTestRegistryContext().repo, visibility: "public" },
    });
    expect(immutableRegistryBlobCacheControl(anonymousPublic)).toBe(
      "public, max-age=31536000, immutable",
    );

    const tokenPublic = createTestRegistryContext({
      repo: { ...createTestRegistryContext().repo, visibility: "public" },
      principal: { kind: "user", userId: "user_1", username: "alice" },
    });
    expect(immutableRegistryBlobCacheControl(tokenPublic)).toBe(
      "private, max-age=31536000, immutable",
    );
  });
});
