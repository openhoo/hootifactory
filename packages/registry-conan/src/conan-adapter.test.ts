import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { ConanAdapter } from "./conan-adapter";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);
const REFERENCE = "zlib/1.2.13@acme/stable";
const RREV = "rrev1";
const PKGID = "pkgid01";
const PREV = "prev1";

function pkgRow(name = REFERENCE): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  metadata: Record<string, unknown>,
  version = RREV,
  createdAt = "2026-01-02T00:00:00.000Z",
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
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function recipeMeta(rrev = RREV, time = "2026-01-02T00:00:00.000Z") {
  return {
    kind: "recipe" as const,
    reference: REFERENCE,
    rrev,
    time,
    files: { "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 } },
  };
}

function packageMeta(prev = PREV, time = "2026-01-03T00:00:00.000Z") {
  return {
    kind: "package" as const,
    reference: REFERENCE,
    rrev: RREV,
    packageId: PKGID,
    prev,
    time,
    files: { "conan_package.tgz": { blobDigest: DIGEST, sizeBytes: 4 } },
  };
}

function conanContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "conan", mountPath: "conan/private" };
  return ctx;
}

function makeAssetRow(scope: string | undefined, digest: string) {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: null,
    packageVersionId: null,
    blobRefId: "ref_1",
    digest,
    role: "conan_file",
    scope: scope ?? "",
    path: null,
    mediaType: null,
    sizeBytes: 0,
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * A minimal stateful fake data service: one version row keyed by version string
 * plus a digest->bytes blob store, so an upload's stored version key and blob
 * scope are the very ones the matching files/download handler resolves. This is
 * what catches a wrong key or scope between write and read.
 */
function makeStatefulStore() {
  const versions = new Map<string, RegistryPackageVersionRow>();
  const blobs = new Map<string, Uint8Array>();
  let nextDigest = 0;
  const pkg = pkgRow();
  return {
    ctx() {
      const ctx = conanContext();
      ctx.data.packages.findByName = async () => pkg;
      ctx.data.packages.findOrCreate = async () => pkg;
      ctx.data.versions.findLive = async (_pkg, version) => versions.get(version) ?? null;
      ctx.data.versions.patch = async ({ version, patch }) => {
        const row = versions.get(version);
        const result = patch(
          row ? { id: row.id, metadata: row.metadata, deletedAt: row.deletedAt } : null,
        );
        if (row && result.update) {
          versions.set(version, {
            ...row,
            metadata: result.update.metadata,
            sizeBytes: result.update.sizeBytes ?? row.sizeBytes,
          });
        }
        return result.result as never;
      };
      ctx.data.versions.upsert = async (input) => {
        versions.set(input.version, versionRow(input.metadata, input.version));
        return `ver_${input.version}`;
      };
      ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
        const digest = `sha256:${String(nextDigest++).padStart(64, "0")}`;
        blobs.set(digest, input.data);
        return {
          digest,
          size: input.data.byteLength,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        };
      };
      ctx.data.assets.upsert = async (input) => makeAssetRow(input.scope, input.digest);
      ctx.data.content.blobRefExists = async ({ digest }) => blobs.has(digest);
      ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
        const bytes = blobs.get(digest) ?? new Uint8Array();
        return new Response(bytes, { headers: { "content-type": contentType } });
      };
      return ctx;
    },
  };
}

const RECIPE_REVISIONS_ENTRY = {
  method: "GET" as const,
  pattern: "/v2/conans/:name/:version/:user/:channel/revisions",
  handlerId: "recipeRevisions",
};
const RECIPE_FILES_ENTRY = {
  method: "GET" as const,
  pattern: "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files",
  handlerId: "recipeFiles",
};
const RECIPE_FILE_DOWNLOAD_ENTRY = {
  method: "GET" as const,
  pattern: "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files/:filename",
  handlerId: "recipeFileDownload",
};
const RECIPE_FILE_UPLOAD_ENTRY = {
  method: "PUT" as const,
  pattern: "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files/:filename",
  handlerId: "recipeFileUpload",
};
const PACKAGE_FILE_DOWNLOAD_ENTRY = {
  method: "GET" as const,
  pattern:
    "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
  handlerId: "packageFileDownload",
};

const recipeRefParams = {
  name: "zlib",
  version: "1.2.13",
  user: "acme",
  channel: "stable",
};

describe("Conan adapter", () => {
  test("declares the full Conan v2 route table with package routes before recipe-file routes", () => {
    expect(new ConanAdapter().routes()).toEqual([
      { method: "GET", pattern: "/v1/ping", handlerId: "ping" },
      // Real clients authenticate via GET; POST is a tolerance alias.
      { method: "GET", pattern: "/v2/users/authenticate", handlerId: "authenticate" },
      { method: "POST", pattern: "/v2/users/authenticate", handlerId: "authenticatePost" },
      { method: "GET", pattern: "/v2/users/check_credentials", handlerId: "checkCredentials" },
      { method: "GET", pattern: "/v2/conans/search", handlerId: "recipeSearch", searchable: true },
      {
        method: "GET",
        pattern:
          "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files",
        handlerId: "packageFiles",
      },
      PACKAGE_FILE_DOWNLOAD_ENTRY,
      {
        method: "PUT",
        pattern:
          "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
        handlerId: "packageFileUpload",
      },
      {
        method: "GET",
        pattern: "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/latest",
        handlerId: "packageLatest",
      },
      {
        method: "GET",
        pattern:
          "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions",
        handlerId: "packageRevisions",
      },
      {
        method: "GET",
        pattern: "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/search",
        handlerId: "packageRevisionSearch",
      },
      RECIPE_FILES_ENTRY,
      RECIPE_FILE_DOWNLOAD_ENTRY,
      RECIPE_FILE_UPLOAD_ENTRY,
      {
        method: "GET",
        pattern: "/v2/conans/:name/:version/:user/:channel/latest",
        handlerId: "recipeLatest",
      },
      RECIPE_REVISIONS_ENTRY,
      {
        method: "GET",
        pattern: "/v2/conans/:name/:version/:user/:channel/search",
        handlerId: "packageConfigSearch",
      },
    ]);
  });

  test("uses read for GET, write for PUT/POST, and a bearer challenge", () => {
    const adapter = new ConanAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    const ctx = conanContext();
    const challenge = adapter.authChallenge({ action: "read" }, ctx);
    expect(challenge.status).toBe(401);
    expect(challenge.header).toContain("Bearer");
    expect(challenge.header).toContain('service="hootifactory"');
  });

  test("recipe-revisions permission targets the recipe package", () => {
    const adapter = new ConanAdapter();
    const match = {
      entry: RECIPE_REVISIONS_ENTRY,
      params: recipeRefParams,
      path: "/v2/conans/zlib/1.2.13/acme/stable/revisions",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: REFERENCE },
    });
  });

  test("package-file download permission targets the revision-scoped artifact", () => {
    const adapter = new ConanAdapter();
    const match = {
      entry: PACKAGE_FILE_DOWNLOAD_ENTRY,
      params: {
        ...recipeRefParams,
        rrev: RREV,
        pkgid: PKGID,
        prev: PREV,
        filename: "conan_package.tgz",
      },
      path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/packages/${PKGID}/revisions/${PREV}/files/conan_package.tgz`,
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: REFERENCE,
        artifactRef: `${REFERENCE}#${RREV}:${PKGID}#${PREV}/conan_package.tgz`,
      },
    });
  });

  test("GET /v1/ping advertises the server capabilities header", async () => {
    const res = await new ConanAdapter().handle(
      {
        entry: { method: "GET", pattern: "/v1/ping", handlerId: "ping" },
        params: {},
        path: "/v1/ping",
      },
      new Request("https://registry.test/v1/ping"),
      conanContext(),
    );
    expect(res.status).toBe(200);
    const caps = res.headers.get("x-conan-server-capabilities") ?? "";
    expect(caps).toContain("revisions");
    expect(caps).toContain("complex_search");
    // checksum_deploy is intentionally NOT advertised: the empty-body dedup probe
    // would hit the upload handler's 400 and fatally abort the upload.
    expect(caps).not.toContain("checksum_deploy");
  });

  test("GET /v2/users/authenticate echoes the bearer-able credential back", async () => {
    const ctx = conanContext();
    ctx.principal = { kind: "user", userId: "u1", username: "alice" };
    // The real Conan v2 client issues authenticate as a GET with HTTP Basic.
    const res = await new ConanAdapter().handle(
      {
        entry: { method: "GET", pattern: "/v2/users/authenticate", handlerId: "authenticate" },
        params: {},
        path: "/v2/users/authenticate",
      },
      new Request("https://registry.test/v2/users/authenticate", {
        headers: { authorization: `Basic ${btoa("alice:secret-token")}` },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("secret-token");
  });

  test("POST /v2/users/authenticate remains a tolerant alias for the same handler", async () => {
    const ctx = conanContext();
    ctx.principal = { kind: "user", userId: "u1", username: "alice" };
    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "POST",
          pattern: "/v2/users/authenticate",
          handlerId: "authenticatePost",
        },
        params: {},
        path: "/v2/users/authenticate",
      },
      new Request("https://registry.test/v2/users/authenticate", {
        method: "POST",
        headers: { authorization: `Basic ${btoa("alice:secret-token")}` },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret-token");
  });

  test("authenticate rejects an anonymous principal with 401", async () => {
    await expect(
      new ConanAdapter().handle(
        {
          entry: { method: "GET", pattern: "/v2/users/authenticate", handlerId: "authenticate" },
          params: {},
          path: "/v2/users/authenticate",
        },
        new Request("https://registry.test/v2/users/authenticate"),
        conanContext(),
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  test("GET /v2/users/check_credentials returns the principal for a valid token", async () => {
    const ctx = conanContext();
    ctx.principal = { kind: "user", userId: "u1", username: "alice" };
    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v2/users/check_credentials",
          handlerId: "checkCredentials",
        },
        params: {},
        path: "/v2/users/check_credentials",
      },
      new Request("https://registry.test/v2/users/check_credentials"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("alice");
  });

  test("recipe revisions lists newest-first with revision + time", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(REFERENCE);
      return pkgRow();
    };
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [
        versionRow(recipeMeta("rrevNew", "2026-02-02T00:00:00.000Z"), "rrevNew"),
        versionRow(recipeMeta("rrevOld", "2026-01-02T00:00:00.000Z"), "rrevOld"),
        // A package-revision row is filtered out of the recipe listing.
        versionRow(packageMeta(), "pkg:pkgid01#prev1"),
      ];
    };
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_REVISIONS_ENTRY,
        params: recipeRefParams,
        path: "/v2/conans/zlib/1.2.13/acme/stable/revisions",
      },
      new Request("https://registry.test/v2/conans/zlib/1.2.13/acme/stable/revisions"),
      ctx,
    );
    expect(res.status).toBe(200);
    // Conan validates the metadata Content-Type with an exact string compare and
    // accepts ONLY the space-separated charset form; bare Response.json() emits a
    // no-space form the client rejects, so assert the exact header here.
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(await res.json()).toEqual({
      revisions: [
        { revision: "rrevNew", time: "2026-02-02T00:00:00.000Z" },
        { revision: "rrevOld", time: "2026-01-02T00:00:00.000Z" },
      ],
    });
  });

  test("recipe latest returns the newest recipe revision", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.listLive = async () => [
      versionRow(recipeMeta("rrevNew", "2026-02-02T00:00:00.000Z"), "rrevNew"),
      versionRow(recipeMeta("rrevOld", "2026-01-02T00:00:00.000Z"), "rrevOld"),
    ];
    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v2/conans/:name/:version/:user/:channel/latest",
          handlerId: "recipeLatest",
        },
        params: recipeRefParams,
        path: "/v2/conans/zlib/1.2.13/acme/stable/latest",
      },
      new Request("https://registry.test/v2/conans/zlib/1.2.13/acme/stable/latest"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: "rrevNew", time: "2026-02-02T00:00:00.000Z" });
  });

  test("recipe files returns the stored file map for a revision", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe(RREV);
      return versionRow({
        ...recipeMeta(),
        files: {
          "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 },
          "conanmanifest.txt": { blobDigest: DIGEST, sizeBytes: 2 },
        },
      });
    };
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILES_ENTRY,
        params: { ...recipeRefParams, rrev: RREV },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files`,
      },
      new Request(
        `https://registry.test/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files`,
      ),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: { "conanfile.py": {}, "conanmanifest.txt": {} } });
  });

  test("package revisions and files resolve the package-binary revision rows", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.listLive = async () => [
      versionRow(packageMeta("prevNew", "2026-03-02T00:00:00.000Z"), "pkg:rrev1:pkgid01#prevNew"),
      // A different package id is excluded.
      versionRow(
        { ...packageMeta("prevOther"), packageId: "otherpkg" },
        "pkg:rrev1:otherpkg#prevOther",
      ),
      // A binary with the same package id under a *different* recipe revision is excluded.
      versionRow(
        { ...packageMeta("prevElsewhere"), rrev: "rrevOther" },
        "pkg:rrevOther:pkgid01#prevElsewhere",
      ),
    ];
    const revs = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern:
            "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions",
          handlerId: "packageRevisions",
        },
        params: { ...recipeRefParams, rrev: RREV, pkgid: PKGID },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/packages/${PKGID}/revisions`,
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(revs.status).toBe(200);
    expect(await revs.json()).toEqual({
      revisions: [{ revision: "prevNew", time: "2026-03-02T00:00:00.000Z" }],
    });

    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("pkg:rrev1:pkgid01#prev1");
      return versionRow(packageMeta());
    };
    const files = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern:
            "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files",
          handlerId: "packageFiles",
        },
        params: { ...recipeRefParams, rrev: RREV, pkgid: PKGID, prev: PREV },
        path: "x",
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(files.status).toBe(200);
    expect(await files.json()).toEqual({ files: { "conan_package.tgz": {} } });
  });

  test("revisions endpoints 404 when the recipe is unknown", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_REVISIONS_ENTRY,
        params: recipeRefParams,
        path: "/v2/conans/zlib/1.2.13/acme/stable/revisions",
      },
      new Request("https://registry.test/v2/conans/zlib/1.2.13/acme/stable/revisions"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("invalid reference segment throws NAME_INVALID", async () => {
    await expect(
      new ConanAdapter().handle(
        {
          entry: RECIPE_REVISIONS_ENTRY,
          params: { ...recipeRefParams, name: "bad name" },
          path: "/v2/conans/bad%20name/1.2.13/acme/stable/revisions",
        },
        new Request("https://registry.test/x"),
        conanContext(),
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("file download resolves the stored blob digest", async () => {
    const ctx = conanContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe(RREV);
      return versionRow(recipeMeta());
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("file-bytes", { headers: { "content-type": contentType } });
    };
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILE_DOWNLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conanfile.py" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanfile.py`,
      },
      new Request(
        `https://registry.test/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanfile.py`,
      ),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("file-bytes");
  });

  test("file download 404s when the file is not part of the revision", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async () => versionRow(recipeMeta());
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILE_DOWNLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "missing.txt" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/missing.txt`,
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("PUT recipe file creates the revision row on the first upload", async () => {
    const ctx = conanContext();
    const captured: {
      upsertVersion?: string;
      metadata?: Record<string, unknown>;
      assetScope?: string;
    } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    // No existing revision row → patch reports "not patched".
    ctx.data.versions.patch = async () => false as never;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.upsert = async (input) => {
      captured.upsertVersion = input.version;
      captured.metadata = input.metadata;
      return "ver_1";
    };
    ctx.data.assets.upsert = async (input) => {
      captured.assetScope = input.scope;
      return {
        id: "asset_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        packageId: null,
        packageVersionId: null,
        blobRefId: input.blobRefId ?? null,
        digest: input.digest,
        role: input.role,
        scope: input.scope ?? "",
        path: input.path ?? null,
        mediaType: input.mediaType ?? null,
        sizeBytes: input.sizeBytes ?? 0,
        metadata: input.metadata ?? {},
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    };

    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILE_UPLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conanfile.py" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanfile.py`,
      },
      new Request("https://registry.test/x", { method: "PUT", body: new Uint8Array([1, 2, 3, 4]) }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-checksum-sha256")).toBe(HEX);
    expect(captured.upsertVersion).toBe(RREV);
    expect(captured.metadata).toMatchObject({
      kind: "recipe",
      reference: REFERENCE,
      rrev: RREV,
      files: { "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 } },
    });
    expect(captured.assetScope).toBe(`${REFERENCE}#${RREV}/conanfile.py`);
  });

  test("PUT recipe file merges into an existing revision row", async () => {
    const ctx = conanContext();
    const captured: {
      patchedFiles?: Record<string, unknown>;
      patchedSizeBytes?: number;
      upsertCalled: boolean;
    } = {
      upsertCalled: false,
    };
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 2,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_2",
    });
    ctx.data.versions.patch = async ({ patch }) => {
      const result = patch({
        id: "ver_existing",
        deletedAt: null,
        metadata: {
          kind: "recipe",
          reference: REFERENCE,
          rrev: RREV,
          time: "2026-01-02T00:00:00.000Z",
          files: { "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 } },
        },
      });
      captured.patchedFiles = (result.update?.metadata.files ?? undefined) as Record<
        string,
        unknown
      >;
      captured.patchedSizeBytes = result.update?.sizeBytes;
      return result.result as never;
    };
    ctx.data.versions.upsert = async () => {
      captured.upsertCalled = true;
      return "ver_x";
    };
    ctx.data.assets.upsert = async () =>
      ({
        id: "a",
        orgId: "o",
        repositoryId: "r",
        packageId: null,
        packageVersionId: null,
        blobRefId: "ref_2",
        digest: DIGEST,
        role: "conan_file",
        scope: "s",
        path: null,
        mediaType: null,
        sizeBytes: 2,
        metadata: {},
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never;

    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILE_UPLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conanmanifest.txt" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanmanifest.txt`,
      },
      new Request("https://registry.test/x", { method: "PUT", body: new Uint8Array([9, 9]) }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(captured.upsertCalled).toBe(false);
    // The existing file is preserved and the new file is added.
    expect(captured.patchedFiles).toEqual({
      "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 },
      "conanmanifest.txt": { blobDigest: DIGEST, sizeBytes: 2 },
    });
    // The revision's total size reflects every file, not just the latest upload.
    expect(captured.patchedSizeBytes).toBe(6);
  });

  test("PUT rejects an empty body with 400", async () => {
    const ctx = conanContext();
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILE_UPLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conanfile.py" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanfile.py`,
      },
      new Request("https://registry.test/x", { method: "PUT" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("scan.referencedDigests surfaces every stored blob digest", () => {
    const scan = new ConanAdapter().scan;
    expect(scan?.referencedDigests?.({ ...recipeMeta() })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ not: "a revision" })).toEqual([]);
  });

  test("declares virtualizable but NOT proxyable (no proxyIngest is wired)", () => {
    const adapter = new ConanAdapter();
    expect(adapter.capabilities.virtualizable).toBe(true);
    expect(adapter.capabilities.proxyable).toBe(false);
  });

  test("check_credentials rejects an anonymous principal with 401", async () => {
    await expect(
      new ConanAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/v2/users/check_credentials",
            handlerId: "checkCredentials",
          },
          params: {},
          path: "/v2/users/check_credentials",
        },
        new Request("https://registry.test/v2/users/check_credentials"),
        conanContext(),
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  test("PUT package binary records the package-scoped revision and asset", async () => {
    const ctx = conanContext();
    const captured: {
      upsertVersion?: string;
      metadata?: Record<string, unknown>;
      assetScope?: string;
      storedScope?: string;
      scanVersion?: string;
    } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.patch = async () => false as never;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      captured.storedScope = input.scope;
      return { digest: DIGEST, size: 4, deduped: false, refCreated: true, blobRefId: "ref_1" };
    };
    ctx.data.versions.upsert = async (input) => {
      captured.upsertVersion = input.version;
      captured.metadata = input.metadata;
      return "ver_1";
    };
    ctx.data.assets.upsert = async (input) => {
      captured.assetScope = input.scope;
      captured.scanVersion = input.scanInput?.version;
      return makeAssetRow(input.scope, input.digest);
    };

    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "PUT",
          pattern:
            "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
          handlerId: "packageFileUpload",
        },
        params: {
          ...recipeRefParams,
          rrev: RREV,
          pkgid: PKGID,
          prev: PREV,
          filename: "conan_package.tgz",
        },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/packages/${PKGID}/revisions/${PREV}/files/conan_package.tgz`,
      },
      new Request("https://registry.test/x", { method: "PUT", body: new Uint8Array([1, 2, 3, 4]) }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(captured.upsertVersion).toBe(`pkg:${RREV}:${PKGID}#${PREV}`);
    expect(captured.metadata).toMatchObject({
      kind: "package",
      reference: REFERENCE,
      rrev: RREV,
      packageId: PKGID,
      prev: PREV,
      files: { "conan_package.tgz": { blobDigest: DIGEST, sizeBytes: 4 } },
    });
    const expectedScope = `${REFERENCE}#${RREV}:${PKGID}#${PREV}/conan_package.tgz`;
    expect(captured.assetScope).toBe(expectedScope);
    expect(captured.storedScope).toBe(expectedScope);
    // A .tgz binary is scannable, so it is enqueued under the package version key.
    expect(captured.scanVersion).toBe(`pkg:${RREV}:${PKGID}#${PREV}`);
  });

  test("PUT does NOT enqueue a scan for a non-tarball file", async () => {
    const ctx = conanContext();
    let scanCalls = 0;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.patch = async () => false as never;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.upsert = async () => "ver_1";
    ctx.data.assets.upsert = async (input) => {
      if (input.scanInput) scanCalls += 1;
      return makeAssetRow(input.scope, input.digest);
    };
    const res = await new ConanAdapter().handle(
      {
        entry: RECIPE_FILE_UPLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conaninfo.txt" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conaninfo.txt`,
      },
      new Request("https://registry.test/x", { method: "PUT", body: new Uint8Array([5, 6]) }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(scanCalls).toBe(0);
  });

  test("package latest returns the newest package-binary revision", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.listLive = async () => [
      versionRow(packageMeta("prevNew", "2026-03-02T00:00:00.000Z"), "pkg:rrev1:pkgid01#prevNew"),
      versionRow(packageMeta("prevOld", "2026-02-02T00:00:00.000Z"), "pkg:rrev1:pkgid01#prevOld"),
    ];
    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern:
            "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/latest",
          handlerId: "packageLatest",
        },
        params: { ...recipeRefParams, rrev: RREV, pkgid: PKGID },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/packages/${PKGID}/latest`,
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: "prevNew", time: "2026-03-02T00:00:00.000Z" });
  });

  test("package-binary file download resolves the package-scoped blob", async () => {
    const ctx = conanContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe(`pkg:${RREV}:${PKGID}#${PREV}`);
      return versionRow(packageMeta());
    };
    ctx.data.content.blobRefExists = async (input) => {
      expect(input.scope).toBe(`${REFERENCE}#${RREV}:${PKGID}#${PREV}/conan_package.tgz`);
      return true;
    };
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("pkg-bytes", { headers: { "content-type": contentType } });
    };
    const res = await new ConanAdapter().handle(
      {
        entry: PACKAGE_FILE_DOWNLOAD_ENTRY,
        params: {
          ...recipeRefParams,
          rrev: RREV,
          pkgid: PKGID,
          prev: PREV,
          filename: "conan_package.tgz",
        },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/packages/${PKGID}/revisions/${PREV}/files/conan_package.tgz`,
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("pkg-bytes");
  });

  test("round-trip: a recipe file upload is readable through files + download", async () => {
    const store = makeStatefulStore();
    const adapter = new ConanAdapter();

    const put = await adapter.handle(
      {
        entry: RECIPE_FILE_UPLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conanfile.py" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanfile.py`,
      },
      new Request("https://registry.test/x", {
        method: "PUT",
        body: new TextEncoder().encode("from conan import ConanFile\n"),
      }),
      store.ctx(),
    );
    expect(put.status).toBe(201);

    const files = await adapter.handle(
      {
        entry: RECIPE_FILES_ENTRY,
        params: { ...recipeRefParams, rrev: RREV },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files`,
      },
      new Request("https://registry.test/x"),
      store.ctx(),
    );
    expect(files.status).toBe(200);
    expect(await files.json()).toEqual({ files: { "conanfile.py": {} } });

    const download = await adapter.handle(
      {
        entry: RECIPE_FILE_DOWNLOAD_ENTRY,
        params: { ...recipeRefParams, rrev: RREV, filename: "conanfile.py" },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/files/conanfile.py`,
      },
      new Request("https://registry.test/x"),
      store.ctx(),
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("from conan import ConanFile\n");
  });

  test("GET /v2/conans/search returns the matching recipe references", async () => {
    const ctx = conanContext();
    ctx.data.packages.listNames = async () => [
      { name: "zlib/1.2.13@acme/stable" },
      { name: "zlibng/2.0.0@acme/stable" },
      { name: "openssl/3.0.0@acme/stable" },
    ];
    const res = await new ConanAdapter().handle(
      {
        entry: { method: "GET", pattern: "/v2/conans/search", handlerId: "recipeSearch" },
        params: {},
        path: "/v2/conans/search",
      },
      new Request("https://registry.test/v2/conans/search?q=zlib/*"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // The anchored glob matches `zlib/...` but not `zlibng/...` or `openssl/...`.
    expect(await res.json()).toEqual({ results: ["zlib/1.2.13@acme/stable"] });
  });

  test("GET /v2/conans/search with no query returns every recipe sorted", async () => {
    const ctx = conanContext();
    ctx.data.packages.listNames = async () => [
      { name: "zlib/1.2.13@acme/stable" },
      { name: "openssl/3.0.0@acme/stable" },
    ];
    const res = await new ConanAdapter().handle(
      {
        entry: { method: "GET", pattern: "/v2/conans/search", handlerId: "recipeSearch" },
        params: {},
        path: "/v2/conans/search",
      },
      new Request("https://registry.test/v2/conans/search"),
      ctx,
    );
    expect(await res.json()).toEqual({
      results: ["openssl/3.0.0@acme/stable", "zlib/1.2.13@acme/stable"],
    });
  });

  test("package-config search returns each package_id's settings/options from conaninfo", async () => {
    const ctx = conanContext();
    const conaninfo =
      "[settings]\n    arch=x86_64\n    build_type=Release\n[options]\n    shared=False\n[requires]\n    fmt/9.Y.Z\n";
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.listLive = async () => [
      versionRow(
        {
          ...packageMeta(),
          files: { "conaninfo.txt": { blobDigest: DIGEST, sizeBytes: conaninfo.length } },
        },
        `pkg:${RREV}:${PKGID}#${PREV}`,
      ),
    ];
    ctx.data.content.getBlobRef = async (input) => {
      expect(input.scope).toBe(`${REFERENCE}#${RREV}:${PKGID}#${PREV}/conaninfo.txt`);
      return {
        digest: input.digest,
        size: conaninfo.length,
        get: () => new Response(conaninfo).body as ReadableStream<Uint8Array>,
        getRange: () => new Response(conaninfo).body as ReadableStream<Uint8Array>,
      };
    };
    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/search",
          handlerId: "packageRevisionSearch",
        },
        params: { ...recipeRefParams, rrev: RREV },
        path: `/v2/conans/zlib/1.2.13/acme/stable/revisions/${RREV}/search`,
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({
      [PKGID]: {
        settings: { arch: "x86_64", build_type: "Release" },
        options: { shared: "False" },
        requires: ["fmt/9.Y.Z"],
      },
    });
  });

  test("package-config search 404s when the recipe is unknown", async () => {
    const ctx = conanContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new ConanAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v2/conans/:name/:version/:user/:channel/search",
          handlerId: "packageConfigSearch",
        },
        params: recipeRefParams,
        path: "/v2/conans/zlib/1.2.13/acme/stable/search",
      },
      new Request("https://registry.test/x"),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});
