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
      { method: "POST", pattern: "/v2/users/authenticate", handlerId: "authenticate" },
      { method: "GET", pattern: "/v2/users/check_credentials", handlerId: "checkCredentials" },
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
      RECIPE_FILES_ENTRY,
      RECIPE_FILE_DOWNLOAD_ENTRY,
      RECIPE_FILE_UPLOAD_ENTRY,
      {
        method: "GET",
        pattern: "/v2/conans/:name/:version/:user/:channel/latest",
        handlerId: "recipeLatest",
      },
      RECIPE_REVISIONS_ENTRY,
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
    expect(res.headers.get("x-conan-server-capabilities")).toContain("revisions");
  });

  test("POST /v2/users/authenticate echoes the bearer-able credential back", async () => {
    const ctx = conanContext();
    ctx.principal = { kind: "user", userId: "u1", username: "alice" };
    const res = await new ConanAdapter().handle(
      {
        entry: { method: "POST", pattern: "/v2/users/authenticate", handlerId: "authenticate" },
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
          entry: { method: "POST", pattern: "/v2/users/authenticate", handlerId: "authenticate" },
          params: {},
          path: "/v2/users/authenticate",
        },
        new Request("https://registry.test/v2/users/authenticate", { method: "POST" }),
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
      versionRow(packageMeta("prevNew", "2026-03-02T00:00:00.000Z"), "pkg:pkgid01#prevNew"),
      // A different package id is excluded.
      versionRow({ ...packageMeta("prevOther"), packageId: "otherpkg" }, "pkg:otherpkg#prevOther"),
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
      expect(version).toBe("pkg:pkgid01#prev1");
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

  test("file download resolves the stored blob digest and redirects on GET", async () => {
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
    const captured: { patchedFiles?: Record<string, unknown>; upsertCalled: boolean } = {
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
});
