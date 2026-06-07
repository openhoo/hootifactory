import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { computeDigest } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handlePuppetProxyIngest } from "./puppet-proxy-lifecycle";
import { puppetArchive } from "./puppet-tarball.test";

const UPSTREAM = "https://forge.test";

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

interface UpstreamRelease {
  version: string;
  metadata?: Record<string, unknown>;
  file_uri?: string;
  file_sha256?: string;
}

/** A fake upstream Forge module document keyed by the module slug. */
function moduleDoc(slug: string, releases: UpstreamRelease[]): unknown {
  const [owner, name] = [slug.slice(0, slug.indexOf("-")), slug.slice(slug.indexOf("-") + 1)];
  return {
    slug,
    owner: { username: owner, slug: owner },
    name,
    current_release: releases[0],
    releases,
  };
}

/** Build an upstream release entry whose `file_sha256` matches `tarball` by default. */
function release(slug: string, version: string, tarball: Uint8Array, fileSha256?: string) {
  return {
    version,
    metadata: { name: slug, version },
    file_uri: `${UPSTREAM}/v3/files/${slug}-${version}.tar.gz`,
    file_sha256: fileSha256 ?? sha256Hex(tarball),
  };
}

/**
 * Install a mock `globalThis.fetch` (safeFetch ultimately calls it, and with
 * enforcePublicNetwork:false it resolves through plain fetch). Routes the module
 * JSON and tarball URLs to in-memory responses; everything else 404s.
 */
function installFetch(routes: Record<string, () => Response>): () => void {
  const original = globalThis.fetch;
  // safeFetch invokes fetch with a URL object (not a string), so normalize via href.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handler = routes[url];
    return handler ? handler() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function tarballResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { headers: { "content-type": "application/gzip" } });
}

interface StoredVersion {
  version: string;
  metadata: Record<string, unknown>;
  data: Uint8Array;
}

/** A test ctx whose package/version store records what proxy ingest writes. */
function proxyContext(stored: StoredVersion[]) {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "puppet", mountPath: "puppet/mirror" };
  const enqueued: { digest: string; version: string }[] = [];
  ctx.enqueueScan = async (input) => {
    enqueued.push({ digest: input.digest, version: input.version ?? "" });
  };
  const existingPkg = {
    id: "pkg_puppetlabs-apache",
    orgId: "org_1",
    repositoryId: "repo_1",
    name: "puppetlabs-apache",
    namespace: "puppetlabs",
    metadata: {},
    latestVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // When the repo already holds releases, the package row already exists; this is
  // what drives the "skip already-held versions" immutability path.
  ctx.data.packages.findByName = async () => (stored.length > 0 ? existingPkg : null);
  ctx.data.packages.findOrCreate = async ({ name }) => ({
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: "puppetlabs",
    metadata: {},
    latestVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  ctx.data.versions.listLive = async () =>
    stored.map((s) => ({
      id: `ver_${s.version}`,
      orgId: "org_1",
      packageId: "pkg_puppetlabs-apache",
      version: s.version,
      metadata: s.metadata,
      sizeBytes: s.data.length,
      publishedByUserId: null,
      publishedByTokenId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  ctx.data.versions.upsertWithBlobRef = async (input) => {
    const digest = computeDigest(input.blob.data);
    stored.push({
      version: input.version,
      metadata: input.metadata as Record<string, unknown>,
      data: input.blob.data,
    });
    return {
      stored: {
        digest,
        size: input.blob.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref",
      },
      versionId: `ver_${input.version}`,
    };
  };
  return { ctx, stored, enqueued };
}

describe("Puppet proxy ingest", () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    // Each test installs its own fetch via installFetch and overwrites `restore`.
  });
  afterEach(() => restore());

  test("mirrors a release whose downloaded bytes match the advertised file_sha256", async () => {
    const slug = "puppetlabs-apache";
    const tarball = puppetArchive(slug, "1.0.0");
    const doc = moduleDoc(slug, [release(slug, "1.0.0", tarball)]);
    restore = installFetch({
      [`${UPSTREAM}/v3/modules/${slug}`]: () => jsonResponse(doc),
      [`${UPSTREAM}/v3/files/${slug}-1.0.0.tar.gz`]: () => tarballResponse(tarball),
    });
    const { ctx, stored, enqueued } = proxyContext([]);

    const ok = await handlePuppetProxyIngest(slug, UPSTREAM, ctx);
    expect(ok).toBe(true);
    expect(stored.map((s) => s.version)).toEqual(["1.0.0"]);
    // The stored file_sha256 equals the sha256 of the bytes that were downloaded.
    expect(stored[0]?.metadata.fileSha256).toBe(sha256Hex(tarball));
    expect(enqueued.map((e) => e.version)).toEqual(["1.0.0"]);
  });

  test("skips a release whose downloaded bytes do NOT match file_sha256", async () => {
    const slug = "puppetlabs-apache";
    const tarball = puppetArchive(slug, "1.0.0");
    // Advertise a wrong checksum: the integrity gate must drop this release.
    const doc = moduleDoc(slug, [release(slug, "1.0.0", tarball, "f".repeat(64))]);
    restore = installFetch({
      [`${UPSTREAM}/v3/modules/${slug}`]: () => jsonResponse(doc),
      [`${UPSTREAM}/v3/files/${slug}-1.0.0.tar.gz`]: () => tarballResponse(tarball),
    });
    const { ctx, stored } = proxyContext([]);

    await handlePuppetProxyIngest(slug, UPSTREAM, ctx);
    expect(stored).toEqual([]);
  });

  test("rejects a file_uri that points off the upstream host", async () => {
    const slug = "puppetlabs-apache";
    const tarball = puppetArchive(slug, "1.0.0");
    const off = {
      version: "1.0.0",
      metadata: { name: slug, version: "1.0.0" },
      file_uri: "https://evil.test/v3/files/puppetlabs-apache-1.0.0.tar.gz",
      file_sha256: sha256Hex(tarball),
    };
    const doc = moduleDoc(slug, [off]);
    let offHostFetched = false;
    restore = installFetch({
      [`${UPSTREAM}/v3/modules/${slug}`]: () => jsonResponse(doc),
      "https://evil.test/v3/files/puppetlabs-apache-1.0.0.tar.gz": () => {
        offHostFetched = true;
        return tarballResponse(tarball);
      },
    });
    const { ctx, stored } = proxyContext([]);

    await handlePuppetProxyIngest(slug, UPSTREAM, ctx);
    expect(stored).toEqual([]);
    // The off-host tarball is never even requested (host-pinned before fetch).
    expect(offHostFetched).toBe(false);
  });

  test("skips versions already held so immutable releases are preserved", async () => {
    const slug = "puppetlabs-apache";
    const tarball = puppetArchive(slug, "1.0.0");
    const doc = moduleDoc(slug, [release(slug, "1.0.0", tarball)]);
    let tarballFetches = 0;
    restore = installFetch({
      [`${UPSTREAM}/v3/modules/${slug}`]: () => jsonResponse(doc),
      [`${UPSTREAM}/v3/files/${slug}-1.0.0.tar.gz`]: () => {
        tarballFetches += 1;
        return tarballResponse(tarball);
      },
    });
    // Already holding 1.0.0.
    const { ctx } = proxyContext([
      { version: "1.0.0", metadata: { version: "1.0.0" }, data: tarball },
    ]);

    await handlePuppetProxyIngest(slug, UPSTREAM, ctx);
    expect(tarballFetches).toBe(0);
  });

  test("filters out releases whose metadata version disagrees with the release version", async () => {
    const slug = "puppetlabs-apache";
    const tarball = puppetArchive(slug, "1.0.0");
    const mismatched = {
      version: "1.0.0",
      // metadata declares a different version than the release entry.
      metadata: { name: slug, version: "9.9.9" },
      file_uri: `${UPSTREAM}/v3/files/${slug}-1.0.0.tar.gz`,
      file_sha256: sha256Hex(tarball),
    };
    const doc = moduleDoc(slug, [mismatched]);
    restore = installFetch({
      [`${UPSTREAM}/v3/modules/${slug}`]: () => jsonResponse(doc),
      [`${UPSTREAM}/v3/files/${slug}-1.0.0.tar.gz`]: () => tarballResponse(tarball),
    });
    const { ctx, stored } = proxyContext([]);

    await handlePuppetProxyIngest(slug, UPSTREAM, ctx);
    expect(stored).toEqual([]);
  });

  test("returns false when the upstream module slug does not match the request", async () => {
    const slug = "puppetlabs-apache";
    const doc = moduleDoc("other-mod", []);
    restore = installFetch({
      [`${UPSTREAM}/v3/modules/${slug}`]: () => jsonResponse(doc),
    });
    const { ctx } = proxyContext([]);

    expect(await handlePuppetProxyIngest(slug, UPSTREAM, ctx)).toBe(false);
  });
});
