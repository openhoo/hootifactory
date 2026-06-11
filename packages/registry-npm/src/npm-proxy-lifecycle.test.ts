import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { RegistryPackageRow, RegistryPackageVersionRow } from "@hootifactory/registry";
import { computeDigest } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { computeNpmTarballDigests } from "./npm-integrity";
import { handleNpmProxyIngest, resolveNpmProxyDistTags } from "./npm-proxy-lifecycle";

type FetchUrl = Parameters<typeof fetch>[0];

const UPSTREAM = "https://registry.npmjs.org";
const realFetch = globalThis.fetch;

/** Replace globalThis.fetch with a typed mock that ignores RequestInit. */
function stubFetch(handler: (url: FetchUrl) => Promise<Response>): void {
  globalThis.fetch = ((url: FetchUrl) => handler(url)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function pkgRow(id: string, name: string, namespace: string | null = null): RegistryPackageRow {
  return {
    id,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  packageId: string,
  version: string,
  metadata: unknown,
): RegistryPackageVersionRow {
  return {
    id: `${packageId}_${version}`,
    orgId: "org_1",
    packageId,
    version,
    metadata,
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

interface UpstreamFixture {
  packumentBody: unknown;
  tarball?: Uint8Array;
  tarballOk?: boolean;
  packumentOk?: boolean;
}

/** Mock globalThis.fetch to serve a packument JSON and a tarball blob. */
function mockUpstream(fixture: UpstreamFixture): void {
  stubFetch(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(".tgz")) {
      if (fixture.tarballOk === false) return new Response("nope", { status: 502 });
      const body = fixture.tarball ?? new Uint8Array();
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    }
    if (fixture.packumentOk === false) return new Response("nope", { status: 404 });
    const json = JSON.stringify(fixture.packumentBody);
    return new Response(json, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(json.length) },
    });
  });
}

describe("npm proxy lifecycle helpers", () => {
  test("keeps only valid dist-tags that resolve to mirrored versions", () => {
    const tags = resolveNpmProxyDistTags(
      {
        latest: "1.0.0",
        beta: "2.0.0",
        "1.0.0": "1.0.0",
        broken: "9.9.9",
      },
      new Map([["1.0.0", { id: "version-1.0.0", packageId: "pkg-1", version: "1.0.0" }]]),
    );

    expect([...tags.entries()]).toEqual([
      ["latest", { id: "version-1.0.0", packageId: "pkg-1", version: "1.0.0" }],
    ]);
  });

  test("ignores non-string dist-tag versions", () => {
    const tags = resolveNpmProxyDistTags(
      { latest: 1 as unknown as string },
      new Map([["1.0.0", { id: "v", packageId: "p", version: "1.0.0" }]]),
    );
    expect(tags.size).toBe(0);
  });
});

describe("handleNpmProxyIngest validation guards", () => {
  test("rejects invalid package names without fetching", async () => {
    let fetched = false;
    stubFetch(async () => {
      fetched = true;
      return new Response("{}");
    });
    const ctx = createTestRegistryContext();
    expect(await handleNpmProxyIngest("INVALID NAME!", UPSTREAM, ctx)).toBe(false);
    expect(fetched).toBe(false);
  });

  test("rejects an unparseable upstream base", async () => {
    const ctx = createTestRegistryContext();
    expect(await handleNpmProxyIngest("pkg", "not a url", ctx)).toBe(false);
  });

  test("returns false when the upstream packument cannot be fetched", async () => {
    mockUpstream({ packumentBody: {}, packumentOk: false });
    const ctx = createTestRegistryContext();
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });

  test("returns false when the upstream packument is not valid JSON shape", async () => {
    stubFetch(
      async () =>
        new Response("[1,2,3]", {
          status: 200,
          headers: { "content-length": "7" },
        }),
    );
    const ctx = createTestRegistryContext();
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });

  test("returns false when no package row exists after ingest (no live versions)", async () => {
    // Versions all invalid/unusable, so ensurePackage is never called and pkg stays null.
    mockUpstream({
      packumentBody: {
        versions: { "not-a-version": { dist: { tarball: `${UPSTREAM}/pkg/-/pkg.tgz` } } },
      },
    });
    const ctx = createTestRegistryContext();
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });
});

describe("handleNpmProxyIngest mirroring", () => {
  test("mirrors a new version, stores the tarball blob, enqueues a scan and replaces tags", async () => {
    const tarball = new TextEncoder().encode("tarball-contents-v1");
    const digests = computeNpmTarballDigests(tarball);
    mockUpstream({
      packumentBody: {
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0",
            dist: {
              tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`,
              integrity: digests.integrity,
              shasum: digests.shasum,
            },
          },
          // unusable manifest: identity mismatch -> skipped
          "2.0.0": { name: "other", version: "2.0.0", dist: { tarball: `${UPSTREAM}/x.tgz` } },
        },
        "dist-tags": { latest: "1.0.0", missing: "9.9.9" },
      },
      tarball,
    });

    const ctx = createTestRegistryContext();
    const created = pkgRow("pkg_1", "pkg");
    let findOrCreateCalls = 0;
    const upsertWithBlobRef: Array<{ version: string; blobDigest: string }> = [];
    const scanned: Array<{ digest: string; version?: string }> = [];
    const replacedTags: Array<Map<string, { version: string }>> = [];

    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async (input) => {
      findOrCreateCalls += 1;
      expect(input).toEqual({ name: "pkg", namespace: null });
      return created;
    };
    ctx.data.versions.listLive = async () => [];
    ctx.data.versions.upsertWithBlobRef = async (input) => {
      // Record the sha256 digest computed from the stored bytes so we can
      // assert the blob handed to the data layer is exactly the mirrored tarball.
      upsertWithBlobRef.push({
        version: input.version,
        blobDigest: computeDigest(input.blob.data),
      });
      expect(input.blob.kind).toBe("npm_tarball");
      expect(input.blob.scope).toBe("pkg@1.0.0");
      return {
        stored: {
          digest: digests.blobDigest,
          size: tarball.byteLength,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        },
        versionId: "ver_1",
      };
    };
    ctx.enqueueScan = async (input) => {
      scanned.push(input);
    };
    ctx.data.tags.replace = async (_pkg, desired) => {
      replacedTags.push(desired as Map<string, { version: string }>);
    };

    const result = await handleNpmProxyIngest("pkg", UPSTREAM, ctx);

    expect(result).toBe(true);
    expect(findOrCreateCalls).toBe(1);
    expect(upsertWithBlobRef).toEqual([{ version: "1.0.0", blobDigest: digests.blobDigest }]);
    expect(scanned[0]).toMatchObject({ digest: digests.blobDigest, version: "1.0.0" });
    expect([...(replacedTags[0]?.keys() ?? [])]).toEqual(["latest"]);
  });

  test("throws when the stored tarball digest does not match the computed digest", async () => {
    const tarball = new TextEncoder().encode("tarball-contents");
    const digests = computeNpmTarballDigests(tarball);
    mockUpstream({
      packumentBody: {
        versions: {
          "1.0.0": {
            dist: {
              tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`,
              integrity: digests.integrity,
            },
          },
        },
      },
      tarball,
    });

    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.listLive = async () => [];
    ctx.data.versions.upsertWithBlobRef = async () => ({
      stored: {
        digest: "sha256:wrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwron",
        size: tarball.byteLength,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      },
      versionId: "ver_1",
    });
    ctx.enqueueScan = async () => {};

    await expect(handleNpmProxyIngest("pkg", UPSTREAM, ctx)).rejects.toThrow(
      "stored npm tarball digest mismatch",
    );
  });

  test("skips a version whose tarball fails integrity verification", async () => {
    const tarball = new TextEncoder().encode("real-bytes");
    mockUpstream({
      packumentBody: {
        versions: {
          "1.0.0": {
            dist: {
              tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`,
              // integrity claims something else, so verification fails
              integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        },
      },
      tarball,
    });

    const ctx = createTestRegistryContext();
    let upserts = 0;
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.listLive = async () => [];
    ctx.data.versions.upsertWithBlobRef = async () => {
      upserts += 1;
      throw new Error("should not store an unverified tarball");
    };

    // pkg stays null because no version was mirrored -> false
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
    expect(upserts).toBe(0);
  });

  test("skips a version whose tarball host is not the configured upstream", async () => {
    const tarball = new TextEncoder().encode("evil");
    const digests = computeNpmTarballDigests(tarball);
    mockUpstream({
      packumentBody: {
        versions: {
          "1.0.0": {
            dist: {
              tarball: "https://evil.example.com/pkg/-/pkg-1.0.0.tgz",
              integrity: digests.integrity,
            },
          },
        },
      },
      tarball,
    });

    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.versions.listLive = async () => [];
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });

  test("reuses an existing live version when the upstream dist matches the stored dist", async () => {
    const stored = {
      filename: "pkg-1.0.0.tgz",
      blobDigest: `sha256:${"a".repeat(64)}`,
      shasum: "b".repeat(40),
      integrity: "sha512-storedstoredstored",
      size: 12,
    };
    const upstreamDist = {
      tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`,
      integrity: stored.integrity,
      shasum: stored.shasum,
    };
    const existing = pkgRow("pkg_1", "pkg");
    // The manifest produced by rewriteNpmProxyManifestForExistingDist must equal
    // the stored manifest for the no-op path; build the stored manifest to match.
    // Key order matches the zod-normalized upstream dist (integrity, shasum, tarball)
    // produced by rewriteNpmProxyManifestForExistingDist so the no-op comparison hits.
    const rewrittenManifest = {
      name: "pkg",
      version: "1.0.0",
      dist: {
        integrity: stored.integrity,
        shasum: stored.shasum,
        tarball: "https://registry.example.test/acme/repo/pkg/-/pkg-1.0.0.tgz",
      },
    };

    mockUpstream({
      packumentBody: {
        versions: { "1.0.0": { name: "pkg", version: "1.0.0", dist: upstreamDist } },
        "dist-tags": { latest: "1.0.0" },
      },
    });

    const ctx = createTestRegistryContext();
    let upserts = 0;
    ctx.data.packages.findByName = async () => existing;
    ctx.data.versions.listLive = async () => [
      versionRow("pkg_1", "1.0.0", { manifest: rewrittenManifest, dist: stored }),
    ];
    ctx.data.versions.upsert = async () => {
      upserts += 1;
      return "ver_x";
    };
    const replaced: Array<Map<string, { version: string }>> = [];
    ctx.data.tags.replace = async (_pkg, desired) => {
      replaced.push(desired as Map<string, { version: string }>);
    };

    const result = await handleNpmProxyIngest("pkg", UPSTREAM, ctx);
    expect(result).toBe(true);
    // No-op: stored manifest already matches, so no upsert occurs.
    expect(upserts).toBe(0);
    expect([...(replaced[0]?.keys() ?? [])]).toEqual(["latest"]);
  });

  test("skips a version when the upstream tarball declares more bytes than allowed", async () => {
    const tarball = new TextEncoder().encode("real-bytes");
    const digests = computeNpmTarballDigests(tarball);
    stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(".tgz")) {
        // Declare a content-length far above the configured upload limit.
        return new Response(tarball, {
          status: 200,
          headers: { "content-length": String(64 * 1024 * 1024) },
        });
      }
      const json = JSON.stringify({
        versions: {
          "1.0.0": {
            dist: { tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`, integrity: digests.integrity },
          },
        },
      });
      return new Response(json, {
        status: 200,
        headers: { "content-length": String(json.length) },
      });
    });

    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.versions.listLive = async () => [];
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });

  test("skips a version when streaming the tarball exceeds the upload limit", async () => {
    stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(".tgz")) {
        // No content-length, but the streamed body is larger than the limit.
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      const json = JSON.stringify({
        versions: {
          "1.0.0": {
            dist: { tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`, integrity: "sha512-x" },
          },
        },
      });
      return new Response(json, {
        status: 200,
        headers: { "content-length": String(json.length) },
      });
    });

    const ctx = createTestRegistryContext({
      limits: { maxUploadBytes: 1024, maxStagedUploadBytes: 1024, enforcePublicNetwork: false },
    });
    ctx.data.packages.findByName = async () => null;
    ctx.data.versions.listLive = async () => [];
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });

  test("skips a version when safeFetch throws fetching the tarball", async () => {
    const digests = computeNpmTarballDigests(new TextEncoder().encode("x"));
    stubFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(".tgz")) throw new Error("network down");
      const json = JSON.stringify({
        versions: {
          "1.0.0": {
            dist: { tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`, integrity: digests.integrity },
          },
        },
      });
      return new Response(json, {
        status: 200,
        headers: { "content-length": String(json.length) },
      });
    });

    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.versions.listLive = async () => [];
    expect(await handleNpmProxyIngest("pkg", UPSTREAM, ctx)).toBe(false);
  });

  test("re-upserts metadata when the stored dist matches but the manifest changed", async () => {
    const stored = {
      filename: "pkg-1.0.0.tgz",
      blobDigest: `sha256:${"c".repeat(64)}`,
      shasum: "d".repeat(40),
      integrity: "sha512-storedstoredstored",
      size: 12,
    };
    const upstreamDist = {
      tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`,
      integrity: stored.integrity,
      shasum: stored.shasum,
    };
    const existing = pkgRow("pkg_1", "pkg");

    mockUpstream({
      packumentBody: {
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0",
            description: "newer description",
            dist: upstreamDist,
          },
        },
      },
    });

    const ctx = createTestRegistryContext();
    const upsertInputs: Array<{ version: string; sizeBytes: number }> = [];
    ctx.data.packages.findByName = async () => existing;
    ctx.data.versions.listLive = async () => [
      versionRow("pkg_1", "1.0.0", {
        manifest: { name: "pkg", version: "1.0.0", description: "old" },
        dist: stored,
      }),
    ];
    ctx.data.versions.upsert = async (input) => {
      upsertInputs.push({ version: input.version, sizeBytes: input.sizeBytes });
      return "ver_updated";
    };
    ctx.data.tags.replace = async () => {};

    const result = await handleNpmProxyIngest("pkg", UPSTREAM, ctx);
    expect(result).toBe(true);
    expect(upsertInputs).toEqual([{ version: "1.0.0", sizeBytes: stored.size }]);
  });
});

describe("handleNpmProxyIngest upstream credentials", () => {
  test("sends Basic auth from the upstream base to the packument and same-host tarball fetches", async () => {
    const tarball = new TextEncoder().encode("tarball-auth");
    const digests = computeNpmTarballDigests(tarball);
    const authByPath: Record<string, string | null> = {};
    globalThis.fetch = (async (input: FetchUrl, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // safeFetch must strip the userinfo from the request URL itself.
      expect(url).not.toContain("hoot-user");
      expect(url).not.toContain("hoot-pass");
      authByPath[new URL(url).pathname] = new Headers(init?.headers).get("authorization");
      if (url.endsWith(".tgz")) {
        return new Response(tarball, {
          status: 200,
          headers: { "content-length": String(tarball.byteLength) },
        });
      }
      const json = JSON.stringify({
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0",
            dist: {
              tarball: `${UPSTREAM}/pkg/-/pkg-1.0.0.tgz`,
              integrity: digests.integrity,
              shasum: digests.shasum,
            },
          },
        },
        "dist-tags": { latest: "1.0.0" },
      });
      return new Response(json, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(json.length) },
      });
    }) as typeof fetch;

    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.listLive = async () => [];
    ctx.data.versions.upsertWithBlobRef = async () => ({
      stored: {
        digest: digests.blobDigest,
        size: tarball.byteLength,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      },
      versionId: "ver_1",
    });
    ctx.enqueueScan = async () => {};
    ctx.data.tags.replace = async () => {};

    expect(
      await handleNpmProxyIngest("pkg", "https://hoot-user:hoot-pass@registry.npmjs.org", ctx),
    ).toBe(true);
    const expectedAuth = `Basic ${Buffer.from("hoot-user:hoot-pass").toString("base64")}`;
    expect(authByPath["/pkg"]).toBe(expectedAuth);
    expect(authByPath["/pkg/-/pkg-1.0.0.tgz"]).toBe(expectedAuth);
  });
});
