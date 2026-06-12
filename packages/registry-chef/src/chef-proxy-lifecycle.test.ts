import { afterEach, describe, expect, test } from "bun:test";
import { computeDigest } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handleChefProxyIngest } from "./chef-proxy-lifecycle";
import { CHEF_FIELD_LIMITS, parseChefVersionMeta } from "./chef-validation";

const UPSTREAM = "https://supermarket.example.test";
const TARBALL = new Uint8Array([7, 8, 9, 10]);
const TARBALL_DIGEST = computeDigest(TARBALL);

type Json = Record<string, unknown>;

/** A fetch router: map an absolute URL to the Response it returns. */
function stubFetch(routes: Map<string, () => Response>): () => void {
  const original = globalThis.fetch;
  const stub = ((input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const make = routes.get(url);
    if (!make) return Promise.resolve(new Response("nope", { status: 404 }));
    return Promise.resolve(make());
  }) as typeof fetch;
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: Json): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tarballResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/gzip", "content-length": String(bytes.length) },
  });
}

/** Build a context whose data layer records every upserted version. */
function ingestContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "chef", mountPath: "chef/proxy" };
  const upserts: { version: string; metadata: Record<string, unknown> }[] = [];
  const scans: { digest: string; name?: string; version?: string; mediaType?: string }[] = [];
  ctx.data.packages.findByName = async () => null;
  ctx.data.packages.findOrCreate = async ({ name }) => ({
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  ctx.data.versions.listLive = async () => [];
  ctx.data.versions.upsertWithBlobRef = async (input) => {
    upserts.push({ version: input.version, metadata: input.metadata });
    // Storage hashes the supplied bytes; mirror that so the lifecycle's
    // `stored.digest === digest` guard holds for honest inputs.
    const digest = computeDigest(input.blob.data);
    if (input.scan) {
      scans.push({ digest, ...input.scan });
    }
    return {
      stored: {
        digest,
        size: input.blob.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      },
      versionId: `ver_${input.version}`,
    };
  };
  return { ctx, upserts, scans };
}

describe("chef proxy ingest lifecycle", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  test("mirrors a cookbook, preserving upstream published_at + descriptive meta", async () => {
    const { ctx, upserts, scans } = ingestContext();
    const versionUrl = `${UPSTREAM}/api/v1/cookbooks/nginx/versions/1_2_3`;
    const fileUrl = `${UPSTREAM}/api/v1/cookbooks/nginx/versions/1_2_3/download`;
    restore = stubFetch(
      new Map([
        [
          `${UPSTREAM}/api/v1/cookbooks/nginx`,
          () =>
            jsonResponse({
              name: "nginx",
              maintainer: "upstream-acme",
              category: "Web Servers",
              external_url: "https://example.test/src",
              issues_url: "https://example.test/issues",
              versions: [versionUrl],
            }),
        ],
        [
          versionUrl,
          () =>
            jsonResponse({
              version: "1.2.3",
              file: fileUrl,
              license: "Apache-2.0",
              description: "Installs nginx",
              dependencies: { apt: ">= 2.0.0" },
              published_at: "2024-05-06T07:08:09.000Z",
            }),
        ],
        [fileUrl, () => tarballResponse(TARBALL)],
      ]),
    );

    const ok = await handleChefProxyIngest("nginx", UPSTREAM, ctx);
    expect(ok).toBe(true);
    expect(upserts).toHaveLength(1);
    const meta = parseChefVersionMeta(upserts[0]?.metadata);
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({
      version: "1.2.3",
      maintainer: "upstream-acme",
      category: "Web Servers",
      source_url: "https://example.test/src",
      issues_url: "https://example.test/issues",
      tarballDigest: TARBALL_DIGEST,
      // The upstream release time is preserved, not the local ingest time.
      published: "2024-05-06T07:08:09.000Z",
    });
    expect(scans).toEqual([
      { digest: TARBALL_DIGEST, name: "nginx", version: "1.2.3", mediaType: "application/gzip" },
    ]);
  });

  test("skips off-host version + tarball URLs (SSRF guard)", async () => {
    const { ctx, upserts } = ingestContext();
    restore = stubFetch(
      new Map([
        [
          `${UPSTREAM}/api/v1/cookbooks/nginx`,
          () =>
            jsonResponse({
              name: "nginx",
              // Both the version-detail URL and (had we reached it) the tarball are
              // off-host; the ingest must not fetch either.
              versions: ["https://evil.test/api/v1/cookbooks/nginx/versions/1_0_0"],
            }),
        ],
      ]),
    );
    await handleChefProxyIngest("nginx", UPSTREAM, ctx);
    // The off-host version is never fetched or mirrored (SSRF guard).
    expect(upserts).toHaveLength(0);
  });

  test("does not re-fetch versions that are already mirrored", async () => {
    const { ctx, upserts } = ingestContext();
    ctx.data.packages.findByName = async () => ({
      id: "pkg_nginx",
      orgId: "org_1",
      repositoryId: "repo_1",
      name: "nginx",
      namespace: null,
      metadata: {},
      latestVersion: "1.2.3",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ctx.data.versions.listLive = async () => [
      {
        id: "ver_1",
        orgId: "org_1",
        packageId: "pkg_nginx",
        version: "1.2.3",
        metadata: {},
        sizeBytes: 4,
        publishedByUserId: null,
        publishedByTokenId: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const versionUrl = `${UPSTREAM}/api/v1/cookbooks/nginx/versions/1_2_3`;
    restore = stubFetch(
      new Map([
        [
          `${UPSTREAM}/api/v1/cookbooks/nginx`,
          () => jsonResponse({ name: "nginx", versions: [versionUrl] }),
        ],
        [
          versionUrl,
          () =>
            jsonResponse({
              version: "1.2.3",
              file: `${UPSTREAM}/d.tar.gz`,
            }),
        ],
      ]),
    );
    const ok = await handleChefProxyIngest("nginx", UPSTREAM, ctx);
    expect(ok).toBe(true);
    // 1.2.3 already exists -> no new upsert.
    expect(upserts).toHaveLength(0);
  });

  test("skips a tarball whose declared content-length exceeds the upload cap", async () => {
    const { ctx, upserts } = ingestContext();
    ctx.limits = { ...ctx.limits, maxUploadBytes: 8 };
    const versionUrl = `${UPSTREAM}/api/v1/cookbooks/nginx/versions/1_0_0`;
    const fileUrl = `${UPSTREAM}/big.tar.gz`;
    restore = stubFetch(
      new Map([
        [
          `${UPSTREAM}/api/v1/cookbooks/nginx`,
          () => jsonResponse({ name: "nginx", versions: [versionUrl] }),
        ],
        [versionUrl, () => jsonResponse({ version: "1.0.0", file: fileUrl })],
        [
          fileUrl,
          () =>
            // Declared length over the cap -> readCappedBody returns null -> skipped.
            new Response(new Uint8Array(64), {
              status: 200,
              headers: { "content-length": "64", "content-type": "application/gzip" },
            }),
        ],
      ]),
    );
    const ok = await handleChefProxyIngest("nginx", UPSTREAM, ctx);
    expect(ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  test("a mirrored version with over-cap fields still round-trips on read (clamped)", async () => {
    const { ctx, upserts } = ingestContext();
    const versionUrl = `${UPSTREAM}/api/v1/cookbooks/nginx/versions/1_0_0`;
    const fileUrl = `${UPSTREAM}/ok.tar.gz`;
    restore = stubFetch(
      new Map([
        [
          `${UPSTREAM}/api/v1/cookbooks/nginx`,
          () => jsonResponse({ name: "nginx", versions: [versionUrl] }),
        ],
        [
          versionUrl,
          () =>
            jsonResponse({
              version: "1.0.0",
              file: fileUrl,
              description: "z".repeat(CHEF_FIELD_LIMITS.description + 200),
              dependencies: { ["d".repeat(CHEF_FIELD_LIMITS.dependencyName + 5)]: ">= 1" },
            }),
        ],
        [fileUrl, () => tarballResponse(TARBALL)],
      ]),
    );
    const ok = await handleChefProxyIngest("nginx", UPSTREAM, ctx);
    expect(ok).toBe(true);
    expect(upserts).toHaveLength(1);
    // The stored metadata parses back (it would be dropped from every read surface
    // if the over-long description / dependency key had been stored unclamped).
    const meta = parseChefVersionMeta(upserts[0]?.metadata);
    expect(meta).not.toBeNull();
    expect(meta?.description?.length).toBe(CHEF_FIELD_LIMITS.description);
    expect(meta?.dependencies).toEqual({});
  });

  test("throws when the stored digest does not match the locally computed digest", async () => {
    const { ctx } = ingestContext();
    // Simulate storage returning a different digest than the bytes we hashed.
    ctx.data.versions.upsertWithBlobRef = async (input) => ({
      stored: {
        digest: `sha256:${"f".repeat(64)}`,
        size: input.blob.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      },
      versionId: `ver_${input.version}`,
    });
    const versionUrl = `${UPSTREAM}/api/v1/cookbooks/nginx/versions/1_0_0`;
    const fileUrl = `${UPSTREAM}/ok.tar.gz`;
    restore = stubFetch(
      new Map([
        [
          `${UPSTREAM}/api/v1/cookbooks/nginx`,
          () => jsonResponse({ name: "nginx", versions: [versionUrl] }),
        ],
        [versionUrl, () => jsonResponse({ version: "1.0.0", file: fileUrl })],
        [fileUrl, () => tarballResponse(TARBALL)],
      ]),
    );
    await expect(handleChefProxyIngest("nginx", UPSTREAM, ctx)).rejects.toThrow(
      "stored chef tarball digest mismatch",
    );
  });

  test("returns false for a malformed upstream base URL", async () => {
    const { ctx } = ingestContext();
    expect(await handleChefProxyIngest("nginx", "not a url", ctx)).toBe(false);
  });
});
