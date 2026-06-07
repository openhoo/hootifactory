import { describe, expect, test } from "bun:test";
import type {
  RegistryManifestRow,
  RegistryPackageRow,
  RegistryRequestContext,
  RegistryUploadedBlob,
  RegistryUploadSessionMutations,
  RegistryUploadSessionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { DockerAdapter } from "./docker-adapter";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REFERRER_DIGEST = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const OTHER_REFERRER_DIGEST =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const REFERRER_ARTIFACT_TYPE = "application/vnd.hootifactory.test.referrer";
const RAW_MANIFEST = JSON.stringify({ schemaVersion: 2 });
const UPLOAD_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const UPLOAD_UUID = "11111111-1111-4111-8111-111111111111";

const ctx = {
  repo: { mountPath: "v2/acme/containers" },
  baseUrl: "https://registry.test",
} as RegistryRequestContext;

const match = {
  entry: { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  params: { name: "team/api", reference: "latest" },
  path: "/team/api/manifests/latest",
} satisfies RouteMatch;

const digestMatch = {
  entry: { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  params: { name: "team/api", reference: DIGEST },
  path: `/team/api/manifests/${DIGEST}`,
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "team/api",
  namespace: null,
  metadata: {},
  latestVersion: "latest",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function manifestRow(): RegistryManifestRow {
  return {
    id: "manifest_1",
    repositoryId: "repo_1",
    digest: DIGEST,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: null,
    subjectDigest: null,
    raw: RAW_MANIFEST,
    sizeBytes: RAW_MANIFEST.length,
    configDigest: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function referrerRow(digest: string): RegistryManifestRow {
  const raw = JSON.stringify({
    schemaVersion: 2,
    artifactType: REFERRER_ARTIFACT_TYPE,
  });
  return {
    id: `manifest_${digest.slice(7, 15)}`,
    repositoryId: "repo_1",
    digest,
    mediaType: "application/vnd.oci.artifact.manifest.v1+json",
    artifactType: REFERRER_ARTIFACT_TYPE,
    subjectDigest: DIGEST,
    raw,
    sizeBytes: raw.length,
    configDigest: null,
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
  };
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function uploadSession(
  overrides: Partial<RegistryUploadSessionRow> = {},
): RegistryUploadSessionRow {
  return {
    id: UPLOAD_UUID,
    repositoryId: "repo_1",
    scope: pkg.name,
    storageKey: "oci/uploads/upload_1",
    offsetBytes: 0,
    state: "open",
    multipart: null,
    expiresAt: new Date("2026-07-04T00:00:00.000Z"),
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Docker adapter contract", () => {
  test("declares the distribution routes clients depend on", () => {
    const handlers = new DockerAdapter().routes().map((route) => route.handlerId);

    expect(handlers).toContain("tagsList");
    expect(handlers).toContain("putManifest");
    expect(handlers).toContain("startUpload");
    expect(handlers).toContain("patchUpload");
    expect(handlers).toContain("getBlob");
    expect(handlers).toContain("deleteBlob");
  });

  test("maps HTTP methods to registry permissions and bearer challenges", () => {
    const adapter = new DockerAdapter();

    expect(adapter.requiredPermission("GET", match, ctx)).toEqual({
      action: "read",
      repositoryName: "acme/containers/team/api",
      resource: { type: "artifact", packageName: "team/api", artifactRef: "latest" },
    });
    expect(adapter.requiredPermission("PUT", match, ctx).action).toBe("write");
    expect(adapter.requiredPermission("DELETE", match, ctx).action).toBe("delete");
    expect(
      adapter.authChallenge({ action: "write", repositoryName: "acme/containers/team/api" }, ctx),
    ).toEqual({
      header:
        'Bearer realm="https://registry.test/token",service="hootifactory",scope="repository:acme/containers/team/api:push,pull"',
      status: 401,
    });
  });

  test("validates matched route params and query values before stateful work", async () => {
    const adapter = new DockerAdapter();

    await expect(
      adapter.handle(
        {
          entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
          params: { name: "../bad" },
          path: "/../bad/tags/list",
        },
        new Request("https://registry.test/v2/acme/containers/../bad/tags/list"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });

    await expect(
      adapter.handle(
        {
          entry: { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
          params: { name: "team/api" },
          path: "/team/api/blobs/uploads",
        },
        new Request(
          "https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=sha256:bad",
          { method: "POST" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
  });

  test("passes tag cursor pagination to the data service", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.contentStore.listTags = async (inputPkg, opts) => {
      expect(inputPkg.id).toBe(pkg.id);
      expect(opts).toEqual({ last: "latest", pageSize: 1 });
      return { tags: ["v1"], truncated: true };
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
        params: { name: pkg.name },
        path: "/team/api/tags/list",
      },
      new Request("https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=latest"),
      ctx,
    );

    expect(response.headers.get("link")).toBe(
      '<https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=v1>; rel="next"',
    );
    await expect(response.json()).resolves.toEqual({
      name: "acme/containers/team/api",
      tags: ["v1"],
    });
  });

  test("filters referrers through one package-scoped batch lookup", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    let packageLookups = 0;
    let subjectLookups = 0;
    let batchLookups = 0;
    ctx.data.packages.findByName = async (name) => {
      packageLookups += 1;
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.contentStore.listSubjectManifests = async (subjectDigest) => {
      subjectLookups += 1;
      expect(subjectDigest).toBe(DIGEST);
      return [referrerRow(REFERRER_DIGEST), referrerRow(OTHER_REFERRER_DIGEST)];
    };
    ctx.data.contentStore.listExistingManifestDigests = async (input) => {
      batchLookups += 1;
      expect(input.package.id).toBe(pkg.id);
      expect(input.digests).toEqual([REFERRER_DIGEST, OTHER_REFERRER_DIGEST]);
      return [REFERRER_DIGEST];
    };
    ctx.data.contentStore.resolveManifest = async () => {
      throw new Error("referrers should not resolve manifests one at a time");
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:name+/referrers/:digest", handlerId: "referrers" },
        params: { name: pkg.name, digest: DIGEST },
        path: `/team/api/referrers/${DIGEST}`,
      },
      new Request(
        `https://registry.test/v2/acme/containers/team/api/referrers/${DIGEST}?artifactType=${encodeURIComponent(
          REFERRER_ARTIFACT_TYPE,
        )}`,
      ),
      ctx,
    );

    expect(packageLookups).toBe(1);
    expect(subjectLookups).toBe(1);
    expect(batchLookups).toBe(1);
    expect(response.headers.get("oci-filters-applied")).toBe("artifactType");
    const body = (await response.json()) as {
      manifests: Array<{ digest: string; artifactType?: string }>;
    };
    expect(body.manifests.map(({ digest, artifactType }) => ({ digest, artifactType }))).toEqual([
      { digest: REFERRER_DIGEST, artifactType: REFERRER_ARTIFACT_TYPE },
    ]);
  });

  test("commits uploaded blobs after streaming outside the locked session", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    const calls: string[] = [];
    let lockDepth = 0;
    let committedOffset = 0;
    const uploaded: RegistryUploadedBlob = { digest: UPLOAD_DIGEST, size: 5, deduped: false };

    ctx.data.contentStore.withLockedUploadSession = async ({ scope, uuid, run }) => {
      expect(scope).toBe(pkg.name);
      expect(uuid).toBe(UPLOAD_UUID);
      calls.push("lock:start");
      lockDepth += 1;
      const mutations: RegistryUploadSessionMutations = {
        assertStagingBudget: async () => {},
        updateOpen: async () => {},
        commitBlobWithRef: async (input) => {
          calls.push("commitBlobWithRef");
          expect(lockDepth).toBe(1);
          expect(input).toEqual({
            blob: uploaded,
            kind: "oci_layer",
            scope: pkg.name,
            mediaType: "application/octet-stream",
          });
          return { ...input.blob, refCreated: true, blobRefId: "blob_ref_1" };
        },
        commit: async (offsetBytes) => {
          calls.push("commit");
          expect(lockDepth).toBe(1);
          committedOffset = offsetBytes;
        },
        markAborted: async () => {},
        deleteSession: async () => {},
      };
      try {
        return await run(uploadSession(), mutations);
      } finally {
        lockDepth -= 1;
        calls.push("lock:end");
      }
    };
    ctx.data.content.uploadBlobStream = async ({ data, expectedDigest }) => {
      calls.push("uploadBlobStream");
      expect(lockDepth).toBe(0);
      expect(expectedDigest).toBe(UPLOAD_DIGEST);
      await expect(readStreamText(data)).resolves.toBe("layer");
      return uploaded;
    };
    ctx.data.content.discardUploadedBlob = async () => {
      throw new Error("committed upload should not be discarded");
    };
    ctx.data.assets.upsert = async (input) => {
      calls.push("asset");
      expect(input.digest).toBe(UPLOAD_DIGEST);
      expect(input.blobRefId).toBe("blob_ref_1");
      expect(input.sizeBytes).toBe(5);
      expect(input.scope).toBe(pkg.name);
      return {
        id: "asset_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        packageId: null,
        packageVersionId: null,
        blobRefId: input.blobRefId ?? null,
        digest: input.digest,
        role: input.role,
        scope: pkg.name,
        path: input.path ?? null,
        mediaType: input.mediaType ?? null,
        sizeBytes: input.sizeBytes ?? 5,
        metadata: input.metadata ?? {},
        deletedAt: null,
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
        updatedAt: new Date("2026-01-04T00:00:00.000Z"),
      };
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "putUpload" },
        params: { name: pkg.name, uuid: UPLOAD_UUID },
        path: `/team/api/blobs/uploads/${UPLOAD_UUID}`,
      },
      new Request(
        `https://registry.test/v2/acme/containers/team/api/blobs/uploads/${UPLOAD_UUID}?digest=${UPLOAD_DIGEST}`,
        { method: "PUT", body: "layer" },
      ),
      ctx,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("docker-content-digest")).toBe(UPLOAD_DIGEST);
    expect(committedOffset).toBe(5);
    expect(calls).toEqual([
      "lock:start",
      "lock:end",
      "uploadBlobStream",
      "lock:start",
      "commitBlobWithRef",
      "commit",
      "lock:end",
      "asset",
    ]);
  });

  test("stages PATCH chunks outside the locked session", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    const calls: string[] = [];
    let lockDepth = 0;
    let session = uploadSession();

    ctx.data.contentStore.withLockedUploadSession = async ({ scope, uuid, run }) => {
      expect(scope).toBe(pkg.name);
      expect(uuid).toBe(UPLOAD_UUID);
      calls.push("lock:start");
      lockDepth += 1;
      const mutations: RegistryUploadSessionMutations = {
        assertStagingBudget: async (input) => {
          calls.push("budget");
          expect(lockDepth).toBe(1);
          expect(input.nextOffsetBytes).toBe(5);
        },
        updateOpen: async (patch) => {
          calls.push("updateOpen");
          expect(lockDepth).toBe(1);
          session = uploadSession({
            offsetBytes: patch.offsetBytes,
            multipart: patch.multipart,
          });
          const parsed = JSON.parse(patch.multipart) as {
            chunks: Array<{ key: string; size: number }>;
          };
          expect(parsed.chunks).toHaveLength(1);
          expect(parsed.chunks[0]?.size).toBe(5);
        },
        commitBlobWithRef: async () => {
          throw new Error("PATCH should not commit blobs");
        },
        commit: async () => {
          throw new Error("PATCH should not commit sessions");
        },
        markAborted: async () => {},
        deleteSession: async () => {},
      };
      try {
        return await run(session, mutations);
      } finally {
        lockDepth -= 1;
        calls.push("lock:end");
      }
    };
    ctx.data.content.staging.putKey = async (key, data) => {
      calls.push("putKey");
      expect(lockDepth).toBe(0);
      expect(key).toStartWith("oci/uploads/upload_1/chunks/0-");
      expect(new TextDecoder().decode(data)).toBe("layer");
    };

    const response = await new DockerAdapter().handle(
      {
        entry: {
          method: "PATCH",
          pattern: "/:name+/blobs/uploads/:uuid",
          handlerId: "patchUpload",
        },
        params: { name: pkg.name, uuid: UPLOAD_UUID },
        path: `/team/api/blobs/uploads/${UPLOAD_UUID}`,
      },
      new Request(
        `https://registry.test/v2/acme/containers/team/api/blobs/uploads/${UPLOAD_UUID}`,
        {
          method: "PATCH",
          body: "layer",
        },
      ),
      ctx,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("range")).toBe("0-4");
    expect(session.offsetBytes).toBe(5);
    expect(calls).toEqual([
      "lock:start",
      "budget",
      "lock:end",
      "putKey",
      "lock:start",
      "budget",
      "updateOpen",
      "lock:end",
    ]);
  });

  test("streams monolithic digest uploads through the blob stream path", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    let streamStores = 0;
    ctx.data.content.storeBlobWithRef = async () => {
      throw new Error("monolithic digest uploads should not use the buffered blob path");
    };
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      streamStores += 1;
      expect(input.expectedDigest).toBe(UPLOAD_DIGEST);
      expect(input.kind).toBe("oci_layer");
      expect(input.scope).toBe(pkg.name);
      expect(input.asset).toEqual({
        role: "oci_layer",
        scope: pkg.name,
        path: `${pkg.name}/blobs/${UPLOAD_DIGEST}`,
        mediaType: "application/octet-stream",
      });
      await expect(readStreamText(input.data)).resolves.toBe("layer");
      return {
        digest: UPLOAD_DIGEST,
        size: 5,
        deduped: false,
        refCreated: true,
        blobRefId: "blob_ref_1",
      };
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
        params: { name: pkg.name },
        path: "/team/api/blobs/uploads",
      },
      new Request(
        `https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=${UPLOAD_DIGEST}`,
        {
          method: "POST",
          body: "layer",
        },
      ),
      ctx,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("docker-content-digest")).toBe(UPLOAD_DIGEST);
    expect(streamStores).toBe(1);
  });

  test("computes route permissions for package-level and digest-pinned routes", () => {
    const adapter = new DockerAdapter();

    // tags/list has neither digest nor reference -> package resource.
    expect(
      adapter.requiredPermission(
        "GET",
        {
          entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
          params: { name: "team/api" },
          path: "/team/api/tags/list",
        },
        ctx,
      ),
    ).toEqual({
      action: "read",
      repositoryName: "acme/containers/team/api",
      resource: { type: "package", packageName: "team/api" },
    });

    // Upload control handlers always require write, even on a GET.
    expect(
      adapter.requiredPermission(
        "GET",
        {
          entry: {
            method: "GET",
            pattern: "/:name+/blobs/uploads/:uuid",
            handlerId: "uploadStatus",
          },
          params: { name: "team/api", uuid: UPLOAD_UUID },
          path: `/team/api/blobs/uploads/${UPLOAD_UUID}`,
        },
        ctx,
      ).action,
    ).toBe("write");

    // POST without a digest/reference -> write on the package resource.
    expect(
      adapter.requiredPermission(
        "POST",
        {
          entry: { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
          params: { name: "team/api" },
          path: "/team/api/blobs/uploads",
        },
        ctx,
      ).resource,
    ).toEqual({ type: "package", packageName: "team/api" });
  });

  test("persists pushed manifests and returns a 201 with location headers", async () => {
    const testCtx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    const raw = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        size: 2,
      },
      layers: [],
    });
    testCtx.data.packages.findOrCreate = async () => pkg;
    testCtx.data.contentStore.listExistingBlobRefDigests = async (input) => input.digests;
    testCtx.data.contentStore.commitManifest = async (input) => ({
      id: "manifest_1",
      repositoryId: "repo_1",
      digest: input.manifest.digest,
    });
    testCtx.data.versions.upsert = async () => "version_1";
    testCtx.data.contentStore.replaceManifestBlobRefs = async () => {};
    testCtx.data.assets.upsert = async () => ({}) as never;
    let scanned = false;
    testCtx.enqueueScan = async () => {
      scanned = true;
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/:name+/manifests/:reference", handlerId: "putManifest" },
        params: { name: pkg.name, reference: "latest" },
        path: "/team/api/manifests/latest",
      },
      new Request("https://registry.test/v2/acme/containers/team/api/manifests/latest", {
        method: "PUT",
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
        body: raw,
      }),
      testCtx,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("docker-content-digest")).toMatch(/^sha256:/);
    expect(response.headers.get("location")).toContain("/team/api/manifests/");
    expect(scanned).toBe(true);
  });

  test("serves HEAD manifests with metadata headers and no body", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.packages.findByName = async () => pkg;
    testCtx.data.contentStore.resolveManifest = async () => manifestRow();
    testCtx.data.content.isArtifactBlocked = async () => false;

    const response = await new DockerAdapter().handle(
      {
        entry: {
          method: "HEAD",
          pattern: "/:name+/manifests/:reference",
          handlerId: "headManifest",
        },
        params: { name: pkg.name, reference: "latest" },
        path: "/team/api/manifests/latest",
      },
      new Request("https://registry.test/v2/acme/containers/team/api/manifests/latest", {
        method: "HEAD",
      }),
      testCtx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("docker-content-digest")).toBe(DIGEST);
    expect(response.headers.get("content-length")).toBe(String(RAW_MANIFEST.length));
    // Tag references are not immutable, so no aggressive cache-control header.
    expect(response.headers.get("cache-control")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });

  test("rejects manifests blocked by scan policy", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.packages.findByName = async () => pkg;
    testCtx.data.contentStore.resolveManifest = async () => manifestRow();
    testCtx.data.content.isArtifactBlocked = async () => true;

    await expect(
      new DockerAdapter().handle(
        match,
        new Request("https://registry.test/v2/acme/containers/team/api/manifests/latest"),
        testCtx,
      ),
    ).rejects.toMatchObject({ code: "DENIED" });
  });

  test("returns 404 for an unknown manifest reference", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.packages.findByName = async () => pkg;
    testCtx.data.contentStore.resolveManifest = async () => null;

    await expect(
      new DockerAdapter().handle(
        match,
        new Request("https://registry.test/v2/acme/containers/team/api/manifests/latest"),
        testCtx,
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_UNKNOWN" });
  });

  test("deletes a tagged manifest and returns 202", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.packages.findByName = async () => pkg;
    let deletedTag = "";
    testCtx.data.contentStore.deleteTag = async ({ tag }) => {
      deletedTag = tag;
      return true;
    };

    const response = await new DockerAdapter().handle(
      {
        entry: {
          method: "DELETE",
          pattern: "/:name+/manifests/:reference",
          handlerId: "deleteManifest",
        },
        params: { name: pkg.name, reference: "latest" },
        path: "/team/api/manifests/latest",
      },
      new Request("https://registry.test/v2/acme/containers/team/api/manifests/latest", {
        method: "DELETE",
      }),
      testCtx,
    );

    expect(response.status).toBe(202);
    expect(deletedTag).toBe("latest");
  });

  test("serves blob bodies through the registry content store", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.content.getBlobRef = async ({ digest, kind, scope }) => {
      expect(digest).toBe(UPLOAD_DIGEST);
      expect(kind).toBe("oci_layer");
      expect(scope).toBe(pkg.name);
      return {
        digest: UPLOAD_DIGEST,
        size: 5,
        get: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("layer"));
              controller.close();
            },
          }),
        getRange: () => {
          throw new Error("unranged GET should not call getRange");
        },
      };
    };
    testCtx.data.packages.findByName = async () => pkg;
    testCtx.data.contentStore.listManifestDigestsReferencingBlob = async () => [];
    testCtx.data.content.areAllArtifactsBlocked = async () => false;

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:name+/blobs/:digest", handlerId: "getBlob" },
        params: { name: pkg.name, digest: UPLOAD_DIGEST },
        path: `/team/api/blobs/${UPLOAD_DIGEST}`,
      },
      new Request(`https://registry.test/v2/acme/containers/team/api/blobs/${UPLOAD_DIGEST}`),
      testCtx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("docker-content-digest")).toBe(UPLOAD_DIGEST);
    await expect(response.text()).resolves.toBe("layer");
  });

  test("returns 404 for an unknown blob digest", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.content.getBlobRef = async () => null;

    await expect(
      new DockerAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:name+/blobs/:digest", handlerId: "getBlob" },
          params: { name: pkg.name, digest: UPLOAD_DIGEST },
          path: `/team/api/blobs/${UPLOAD_DIGEST}`,
        },
        new Request(`https://registry.test/v2/acme/containers/team/api/blobs/${UPLOAD_DIGEST}`),
        testCtx,
      ),
    ).rejects.toMatchObject({ code: "BLOB_UNKNOWN" });
  });

  test("blocks blob reads reachable only through blocked manifests", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.content.getBlobRef = async () => ({
      digest: UPLOAD_DIGEST,
      size: 5,
      get: () => {
        throw new Error("blocked blobs should never stream");
      },
      getRange: () => {
        throw new Error("blocked blobs should never stream");
      },
    });
    testCtx.data.packages.findByName = async () => pkg;
    testCtx.data.contentStore.listManifestDigestsReferencingBlob = async () => [DIGEST];
    testCtx.data.content.areAllArtifactsBlocked = async () => true;

    await expect(
      new DockerAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:name+/blobs/:digest", handlerId: "getBlob" },
          params: { name: pkg.name, digest: UPLOAD_DIGEST },
          path: `/team/api/blobs/${UPLOAD_DIGEST}`,
        },
        new Request(`https://registry.test/v2/acme/containers/team/api/blobs/${UPLOAD_DIGEST}`),
        testCtx,
      ),
    ).rejects.toMatchObject({ code: "DENIED" });
  });

  test("deletes blob references and echoes the digest", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.contentStore.blobRefExists = async () => true;
    let released = "";
    testCtx.data.content.releaseBlobRef = async ({ digest }) => {
      released = digest;
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "DELETE", pattern: "/:name+/blobs/:digest", handlerId: "deleteBlob" },
        params: { name: pkg.name, digest: UPLOAD_DIGEST },
        path: `/team/api/blobs/${UPLOAD_DIGEST}`,
      },
      new Request(`https://registry.test/v2/acme/containers/team/api/blobs/${UPLOAD_DIGEST}`, {
        method: "DELETE",
      }),
      testCtx,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("docker-content-digest")).toBe(UPLOAD_DIGEST);
    expect(released).toBe(UPLOAD_DIGEST);
  });

  test("returns an empty referrers list when the package is unknown", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.packages.findByName = async () => null;
    testCtx.data.contentStore.listSubjectManifests = async () => {
      throw new Error("referrers should short-circuit for an unknown package");
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:name+/referrers/:digest", handlerId: "referrers" },
        params: { name: pkg.name, digest: DIGEST },
        path: `/team/api/referrers/${DIGEST}`,
      },
      new Request(`https://registry.test/v2/acme/containers/team/api/referrers/${DIGEST}`),
      testCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { manifests: unknown[] };
    expect(body.manifests).toEqual([]);
  });

  test("rejects an unknown package on tags/list", async () => {
    const testCtx = createTestRegistryContext();
    testCtx.repo = { ...testCtx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    testCtx.data.packages.findByName = async () => null;

    await expect(
      new DockerAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
          params: { name: pkg.name },
          path: "/team/api/tags/list",
        },
        new Request("https://registry.test/v2/acme/containers/team/api/tags/list"),
        testCtx,
      ),
    ).rejects.toMatchObject({ code: "NAME_UNKNOWN" });
  });

  test("digest-pinned manifests use principal-aware immutable validators and honor If-None-Match", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
    let blockChecks = 0;
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.contentStore.resolveManifest = async (input) => {
      expect(input.package.id).toBe(pkg.id);
      expect(input.reference).toBe(DIGEST);
      return manifestRow();
    };
    ctx.data.content.isArtifactBlocked = async (digest) => {
      blockChecks += 1;
      expect(digest).toBe(DIGEST);
      return false;
    };

    const adapter = new DockerAdapter();
    const first = await adapter.handle(
      digestMatch,
      new Request(`https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`),
      ctx,
    );
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBe(`"${DIGEST}"`);
    expect(first.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(first.headers.get("docker-content-digest")).toBe(DIGEST);
    await expect(first.text()).resolves.toBe(RAW_MANIFEST);

    const cached = await adapter.handle(
      digestMatch,
      new Request(`https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`, {
        headers: { "if-none-match": etag ?? "" },
      }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(`"${DIGEST}"`);
    expect(cached.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(cached.headers.get("content-length")).toBeNull();
    await expect(cached.text()).resolves.toBe("");
    expect(blockChecks).toBe(2);
  });
});
