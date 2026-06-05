import { describe, expect, test } from "bun:test";
import {
  computeDigest,
  type RegistryPackageRow,
  type RegistryPackageVersionRow,
  type RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { SwiftAdapter } from "./swift-adapter";
import { MAX_MANIFEST_BYTES } from "./swift-manifest";
import {
  isValidSwiftName,
  isValidSwiftScope,
  isValidSwiftVersion,
  parseSwiftVersionMeta,
  swiftPackageId,
} from "./swift-validation";

const CHECKSUM = "a".repeat(64);
const ARCHIVE_DIGEST = `sha256:${CHECKSUM}`;

// Stored package names are case-normalized per SE-0292 (mona.LinkedList -> mona.linkedlist).
const pkg: RegistryPackageRow = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "mona.linkedlist",
  namespace: "mona",
  metadata: {},
  latestVersion: "1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function versionRow(metadata: unknown): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: pkg.id,
    version: "1.0.0",
    metadata,
    sizeBytes: 8,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  };
}

const storedMeta = {
  archiveDigest: ARCHIVE_DIGEST,
  checksum: CHECKSUM,
  metadata: { author: "mona", repositoryURL: "https://github.com/mona/LinkedList" },
  manifest: "// swift-tools-version:5.9\n",
};

function ctxWithPackage() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "swift", mountPath: "swift/private" };
  ctx.data.packages.findByName = async (name) => (name === pkg.name ? pkg : null);
  return ctx;
}

describe("Swift adapter validation", () => {
  test("validates package scopes", () => {
    expect(isValidSwiftScope("mona")).toBe(true);
    expect(isValidSwiftScope("apple-swift")).toBe(true);
    expect(isValidSwiftScope("-mona")).toBe(false);
    expect(isValidSwiftScope("mona-")).toBe(false);
    expect(isValidSwiftScope("mo--na")).toBe(false);
    expect(isValidSwiftScope("mona.bad")).toBe(false);
  });

  test("validates package names", () => {
    expect(isValidSwiftName("LinkedList")).toBe(true);
    expect(isValidSwiftName("Linked_List-2")).toBe(true);
    expect(isValidSwiftName("bad/name")).toBe(false);
    expect(isValidSwiftName("../etc")).toBe(false);
    // SE-0292: hyphens/underscores may not be leading, trailing, or consecutive.
    expect(isValidSwiftName("-foo")).toBe(false);
    expect(isValidSwiftName("foo-")).toBe(false);
    expect(isValidSwiftName("_foo")).toBe(false);
    expect(isValidSwiftName("foo_")).toBe(false);
    expect(isValidSwiftName("foo--bar")).toBe(false);
    expect(isValidSwiftName("foo__bar")).toBe(false);
    expect(isValidSwiftName("foo-_bar")).toBe(false);
  });

  test("validates SemVer versions", () => {
    expect(isValidSwiftVersion("1.0.0")).toBe(true);
    expect(isValidSwiftVersion("1.2.3-alpha.1+build.5")).toBe(true);
    expect(isValidSwiftVersion("1.2")).toBe(false);
    expect(isValidSwiftVersion("01.0.0")).toBe(false);
  });

  test("derives a case-normalized package id from scope and name", () => {
    expect(swiftPackageId("mona", "LinkedList")).toBe("mona.linkedlist");
    // Differing casings of the same identifier collapse to one stored key.
    expect(swiftPackageId("Mona", "linkedlist")).toBe("mona.linkedlist");
  });

  test("accepts manifests up to the extractor byte limit", () => {
    expect(
      parseSwiftVersionMeta({
        archiveDigest: ARCHIVE_DIGEST,
        checksum: CHECKSUM,
        metadata: {},
        manifest: "a".repeat(MAX_MANIFEST_BYTES),
      })?.manifest?.length,
    ).toBe(MAX_MANIFEST_BYTES);
  });
});

describe("Swift adapter routes", () => {
  test("declares identifiers, releases, manifest, release, and publish routes in order", () => {
    expect(new SwiftAdapter().routes()).toEqual([
      { method: "GET", pattern: "/identifiers", handlerId: "identifiers" },
      { method: "GET", pattern: "/:scope/:name", handlerId: "releases" },
      {
        method: "GET",
        pattern: "/:scope/:name/:version/Package.swift",
        handlerId: "manifest",
      },
      { method: "GET", pattern: "/:scope/:name/:ref", handlerId: "release" },
      { method: "PUT", pattern: "/:scope/:name/:version", handlerId: "publish" },
    ]);
  });

  test("uses read permissions for reads and write permissions for mutations", () => {
    const adapter = new SwiftAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Bearer realm="hootifactory"');
  });

  test("scopes write permission to the lowercased package and archive ref", () => {
    const adapter = new SwiftAdapter();
    const publishMatch = {
      entry: { method: "PUT", pattern: "/:scope/:name/:version", handlerId: "publish" },
      params: { scope: "Mona", name: "LinkedList", version: "1.0.0" },
      path: "/Mona/LinkedList/1.0.0",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("PUT", publishMatch)).toEqual({
      action: "write",
      resource: { type: "package", packageName: "mona.linkedlist" },
    });

    const downloadMatch = {
      entry: { method: "GET", pattern: "/:scope/:name/:ref", handlerId: "release" },
      params: { scope: "mona", name: "LinkedList", ref: "1.0.0.zip" },
      path: "/mona/LinkedList/1.0.0.zip",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", downloadMatch)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "mona.linkedlist",
        artifactRef: "mona.linkedlist@1.0.0.zip",
      },
    });
  });
});

const releasesMatch = {
  entry: { method: "GET", pattern: "/:scope/:name", handlerId: "releases" },
  params: { scope: "mona", name: "LinkedList" },
  path: "/mona/LinkedList",
} satisfies RouteMatch;

const releaseMetadataMatch = {
  entry: { method: "GET", pattern: "/:scope/:name/:ref", handlerId: "release" },
  params: { scope: "mona", name: "LinkedList", ref: "1.0.0" },
  path: "/mona/LinkedList/1.0.0",
} satisfies RouteMatch;

const archiveMatch = {
  entry: { method: "GET", pattern: "/:scope/:name/:ref", handlerId: "release" },
  params: { scope: "mona", name: "LinkedList", ref: "1.0.0.zip" },
  path: "/mona/LinkedList/1.0.0.zip",
} satisfies RouteMatch;

const manifestMatch = {
  entry: { method: "GET", pattern: "/:scope/:name/:version/Package.swift", handlerId: "manifest" },
  params: { scope: "mona", name: "LinkedList", version: "1.0.0" },
  path: "/mona/LinkedList/1.0.0/Package.swift",
} satisfies RouteMatch;

describe("Swift adapter handlers", () => {
  test("lists live releases with absolute urls and Content-Version", async () => {
    const ctx = ctxWithPackage();
    ctx.data.versions.listLive = async (row, opts) => {
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow(storedMeta)];
    };

    const res = await new SwiftAdapter().handle(
      releasesMatch,
      new Request("https://registry.test/mona/LinkedList"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      releases: {
        "1.0.0": {
          url: "https://registry.example.test/swift/private/mona/LinkedList/1.0.0",
        },
      },
    });
  });

  test("returns release metadata with the hex checksum resource", async () => {
    const ctx = ctxWithPackage();
    ctx.data.versions.findLive = async (_row, version) => {
      expect(version).toBe("1.0.0");
      return versionRow(storedMeta);
    };

    const res = await new SwiftAdapter().handle(
      releaseMetadataMatch,
      new Request("https://registry.test/mona/LinkedList/1.0.0"),
      ctx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("mona.linkedlist");
    expect(body.version).toBe("1.0.0");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(body.resources).toEqual([
      { name: "source-archive", type: "application/zip", checksum: CHECKSUM },
    ]);
    expect(body.metadata).toEqual(storedMeta.metadata);
  });

  test("download resolves the stored digest and sets the SwiftPM headers", async () => {
    const ctx = ctxWithPackage();
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    ctx.data.content.blobRefExists = async (input) => {
      expect(input.digest).toBe(ARCHIVE_DIGEST);
      expect(input.kind).toBe("swift_archive");
      return true;
    };
    let servedDigest: string | undefined;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType, extraHeaders }) => {
      servedDigest = digest;
      return new Response("zip-bytes", {
        headers: { "content-type": contentType, ...extraHeaders },
      });
    };

    const res = await new SwiftAdapter().handle(
      archiveMatch,
      new Request("https://registry.test/mona/LinkedList/1.0.0.zip"),
      ctx,
    );

    expect(servedDigest).toBe(ARCHIVE_DIGEST);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="LinkedList-1.0.0.zip"',
    );
    expect(res.headers.get("digest")).toBe(
      `sha-256=${Buffer.from(CHECKSUM, "hex").toString("base64")}`,
    );
    expect(res.headers.get("content-version")).toBe("1");
  });

  test("download scan blocks are problem+json with Content-Version", async () => {
    const ctx = ctxWithPackage();
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ blocked }) =>
      blocked ? blocked() : new Response("unexpected", { status: 500 });

    const res = await new SwiftAdapter().handle(
      archiveMatch,
      new Request("https://registry.test/mona/LinkedList/1.0.0.zip"),
      ctx,
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("content-version")).toBe("1");
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      status: 403,
      detail: "blocked by scan policy",
    });
  });

  test("serves the stored Package.swift manifest as text/x-swift", async () => {
    const ctx = ctxWithPackage();
    ctx.data.versions.findLive = async () => versionRow(storedMeta);

    const res = await new SwiftAdapter().handle(
      manifestMatch,
      new Request("https://registry.test/mona/LinkedList/1.0.0/Package.swift"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-swift");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Package.swift"');
    expect(await res.text()).toBe("// swift-tools-version:5.9\n");
  });

  test("falls back to a tools-version stub when no manifest was stored", async () => {
    const ctx = ctxWithPackage();
    ctx.data.versions.findLive = async () =>
      versionRow({ archiveDigest: ARCHIVE_DIGEST, checksum: CHECKSUM, metadata: {} });

    const res = await new SwiftAdapter().handle(
      manifestMatch,
      new Request("https://registry.test/mona/LinkedList/1.0.0/Package.swift"),
      ctx,
    );

    expect(await res.text()).toBe("// swift-tools-version:5.0\n");
  });

  test("renders an unknown package as a problem+json 404 carrying Content-Version", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "swift", mountPath: "swift/private" };
    const res = await new SwiftAdapter().handle(
      releasesMatch,
      new Request("https://registry.test/mona/LinkedList"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("content-version")).toBe("1");
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: 404 });
  });

  test("renders unexpected handler errors as problem+json 500 carrying Content-Version", async () => {
    const ctx = ctxWithPackage();
    ctx.data.packages.findByName = async () => {
      throw new Error("database unavailable");
    };

    const res = await new SwiftAdapter().handle(
      releasesMatch,
      new Request("https://registry.test/mona/LinkedList"),
      ctx,
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("content-version")).toBe("1");
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      status: 500,
      detail: "internal server error",
    });
  });

  test("maps a repository url to identifiers", async () => {
    const ctx = ctxWithPackage();
    ctx.data.packages.list = async () => [
      { id: pkg.id, orgId: pkg.orgId, repositoryId: pkg.repositoryId, name: pkg.name },
    ];
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const match = {
      entry: { method: "GET", pattern: "/identifiers", handlerId: "identifiers" },
      params: {},
      path: "/identifiers",
    } satisfies RouteMatch;
    const res = await new SwiftAdapter().handle(
      match,
      new Request("https://registry.test/identifiers?url=https://github.com/mona/LinkedList"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ identifiers: ["mona.linkedlist"] });
  });

  test("returns a problem+json 404 when no package matches a repository url", async () => {
    const ctx = ctxWithPackage();
    ctx.data.packages.list = async () => [];

    const match = {
      entry: { method: "GET", pattern: "/identifiers", handlerId: "identifiers" },
      params: {},
      path: "/identifiers",
    } satisfies RouteMatch;
    const res = await new SwiftAdapter().handle(
      match,
      new Request("https://registry.test/identifiers?url=https://example.test/none"),
      ctx,
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("content-version")).toBe("1");
  });
});

const PUBLISH_ARCHIVE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]);
const PUBLISH_BOUNDARY = "X-SWIFT-BOUNDARY";

function publishMultipart(archive?: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  if (archive) {
    chunks.push(
      enc.encode(
        `--${PUBLISH_BOUNDARY}\r\n` +
          'Content-Disposition: form-data; name="source-archive"\r\n' +
          "Content-Type: application/zip\r\n\r\n",
      ),
      archive,
      enc.encode("\r\n"),
    );
  }
  chunks.push(enc.encode(`--${PUBLISH_BOUNDARY}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return body;
}

function publishRequest(body: Uint8Array | string, contentType: string): Request {
  return new Request("https://registry.test/mona/LinkedList/1.0.0", {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
}

const publishMatch = {
  entry: { method: "PUT", pattern: "/:scope/:name/:version", handlerId: "publish" },
  params: { scope: "mona", name: "LinkedList", version: "1.0.0" },
  path: "/mona/LinkedList/1.0.0",
} satisfies RouteMatch;

function publishContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "swift", mountPath: "swift/private" };
  ctx.data.packages.findByName = async () => null;
  ctx.data.packages.findOrCreate = async ({ name, namespace }) => ({
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: namespace ?? null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  ctx.data.versions.exists = async () => false;
  ctx.data.content.storeBlobWithRef = async (input) => ({
    digest: computeDigest(input.data),
    size: input.data.byteLength,
    deduped: false,
    refCreated: true,
    blobRefId: "ref_1",
  });
  ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });
  return ctx;
}

describe("Swift adapter publish route", () => {
  test("publishes via PUT and shapes a 201 with Location and Content-Version", async () => {
    const ctx = publishContext();
    const res = await new SwiftAdapter().handle(
      publishMatch,
      publishRequest(
        publishMultipart(PUBLISH_ARCHIVE),
        `multipart/form-data; boundary=${PUBLISH_BOUNDARY}`,
      ),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(
      "https://registry.example.test/swift/private/mona/LinkedList/1.0.0",
    );
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("swift-package-digest")).toBe(
      computeDigest(PUBLISH_ARCHIVE).slice("sha256:".length),
    );
  });

  test("rejects a non-multipart body with a 415 problem+json", async () => {
    const ctx = publishContext();
    const res = await new SwiftAdapter().handle(
      publishMatch,
      publishRequest("{}", "application/json"),
      ctx,
    );

    expect(res.status).toBe(415);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: 415 });
  });

  test("rejects a missing source-archive part with a 422 problem+json", async () => {
    const ctx = publishContext();
    const res = await new SwiftAdapter().handle(
      publishMatch,
      publishRequest(publishMultipart(), `multipart/form-data; boundary=${PUBLISH_BOUNDARY}`),
      ctx,
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  test("rejects a duplicate version with a 409 problem+json", async () => {
    const ctx = publishContext();
    ctx.data.packages.findByName = async () => ({
      id: "pkg_1",
      orgId: "org_1",
      repositoryId: "repo_1",
      name: "mona.linkedlist",
      namespace: "mona",
      metadata: {},
      latestVersion: "1.0.0",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    ctx.data.versions.exists = async () => true;

    const res = await new SwiftAdapter().handle(
      publishMatch,
      publishRequest(
        publishMultipart(PUBLISH_ARCHIVE),
        `multipart/form-data; boundary=${PUBLISH_BOUNDARY}`,
      ),
      ctx,
    );

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("content-version")).toBe("1");
  });
});
