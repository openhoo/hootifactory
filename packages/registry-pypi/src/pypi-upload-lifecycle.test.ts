import { describe, expect, test } from "bun:test";
import { InvalidDigestError } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  buildPypiFileMetadata,
  handlePypiUpload,
  pypiScanMediaType,
} from "./pypi-upload-lifecycle";

function uploadRequest(input: { sha256?: string } = {}): Request {
  const form = new FormData();
  form.set("name", "hoot_lib");
  form.set("version", "1.2.3");
  form.set("sha256_digest", input.sha256 ?? "0".repeat(64));
  form.set(
    "content",
    new File([new TextEncoder().encode("wheel-bytes")], "hoot_lib-1.2.3-py3-none-any.whl"),
  );
  return new Request("https://registry.test/legacy/", { method: "POST", body: form });
}

describe("PyPI upload lifecycle helpers", () => {
  test("builds file metadata from the stored blob digest and upload plan", () => {
    expect(
      buildPypiFileMetadata(
        {
          filename: "hoot_lib-1.2.3-py3-none-any.whl",
          filetype: "bdist_wheel",
          requiresPython: ">=3.11",
          size: 4,
        },
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual({
      filename: "hoot_lib-1.2.3-py3-none-any.whl",
      blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiresPython: ">=3.11",
      size: 4,
      filetype: "bdist_wheel",
    });
  });

  test("keeps the existing scan media type split", () => {
    expect(pypiScanMediaType("bdist_wheel")).toBe("application/zip");
    expect(pypiScanMediaType("sdist")).toBe("application/x-tar");
    expect(pypiScanMediaType(undefined)).toBe("application/x-tar");
  });

  test("maps streaming digest mismatches to the legacy upload error", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = () => Promise.resolve(null);
    ctx.data.packages.findByName = () => Promise.resolve(null);
    ctx.data.packages.findOrCreate = () => {
      throw new Error("should not create package when digest validation fails");
    };
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      expect(input.expectedDigest).toBe(`sha256:${"0".repeat(64)}`);
      throw new InvalidDigestError("mismatch");
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      message: "sha256_digest does not match uploaded content",
    });
  });

  test("writes uploaded file assets with the stored blob ref", async () => {
    const ctx = createTestRegistryContext();
    const digest = `sha256:${"a".repeat(64)}`;
    const pkg = {
      id: "pkg_1",
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: "hoot-lib",
      namespace: null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let assetBlobRefId: string | null | undefined;

    ctx.data.assets.findByScope = () => Promise.resolve(null);
    ctx.data.packages.findByName = () => Promise.resolve(null);
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.content.storeBlobStreamWithRef = async () => ({
      digest,
      size: 11,
      deduped: false,
      refCreated: true,
      blobRefId: "blob_ref_1",
    });
    ctx.data.versions.create = async () => "version_1";
    ctx.data.assets.upsert = async (input) => {
      assetBlobRefId = input.blobRefId;
      return {
        id: "asset_1",
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        packageId: input.package?.id ?? null,
        packageVersionId: input.packageVersion?.id ?? null,
        blobRefId: input.blobRefId ?? null,
        digest: input.digest,
        role: input.role,
        scope: input.scope ?? "",
        path: input.path ?? null,
        mediaType: input.mediaType ?? null,
        sizeBytes: input.sizeBytes ?? 0,
        metadata: input.metadata ?? {},
        deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    };

    const res = await handlePypiUpload(uploadRequest({ sha256: "a".repeat(64) }), ctx);

    expect(res.status).toBe(200);
    expect(assetBlobRefId).toBe("blob_ref_1");
  });

  test("rejects an invalid upload request before touching the data layer", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = () => {
      throw new Error("should not read assets for an invalid request");
    };

    const res = await handlePypiUpload(
      new Request("https://registry.test/legacy/", { method: "POST", body: new FormData() }),
      ctx,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("rejects a re-upload of an existing distribution filename", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async (input) => {
      expect(input.includeDeleted).toBe(true);
      return {
        id: "asset_existing",
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        packageId: "pkg_1",
        packageVersionId: "ver_1",
        blobRefId: "blob_ref_existing",
        digest: `sha256:${"a".repeat(64)}`,
        role: "pypi_file",
        scope: "hoot_lib-1.2.3-py3-none-any.whl",
        path: "hoot_lib-1.2.3-py3-none-any.whl",
        mediaType: "application/octet-stream",
        sizeBytes: 11,
        metadata: {},
        deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    };
    ctx.data.content.storeBlobStreamWithRef = () => {
      throw new Error("should not store a blob for a duplicate filename");
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ message: "File already exists." });
  });

  test("rejects re-publishing a soft-deleted release version", async () => {
    const ctx = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: "hoot-lib",
      namespace: null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    ctx.data.assets.findByScope = async () => null;
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.find = async () => ({
      id: "ver_1",
      orgId: ctx.repo.orgId,
      packageId: pkg.id,
      version: "1.2.3",
      metadata: {},
      sizeBytes: 1,
      publishedByUserId: null,
      publishedByTokenId: null,
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    ctx.data.content.storeBlobStreamWithRef = () => {
      throw new Error("should not store a blob for a deleted release");
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ message: "Release version already exists." });
  });

  test("rethrows non-digest store failures", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async () => null;
    ctx.data.packages.findByName = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new Error("storage exploded");
    };

    await expect(handlePypiUpload(uploadRequest(), ctx)).rejects.toThrow("storage exploded");
  });

  test("appends a file to an existing release via the patch path", async () => {
    const ctx = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: "hoot-lib",
      namespace: null,
      metadata: {},
      latestVersion: "1.2.3",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let upsertScope: string | undefined;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => ({
      digest: `sha256:${"b".repeat(64)}`,
      size: 11,
      deduped: false,
      refCreated: true,
      blobRefId: "blob_ref_patch",
    });
    // create() returns null => existing version => patch() runs.
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const outcome = patch({
        id: "ver_1",
        metadata: { name: "hoot_lib", files: [] },
        deletedAt: null,
      });
      return outcome.result;
    };
    ctx.data.assets.upsert = async (input) => {
      upsertScope = input.scope;
      return {
        id: "asset_1",
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        packageId: input.package?.id ?? null,
        packageVersionId: input.packageVersion?.id ?? null,
        blobRefId: input.blobRefId ?? null,
        digest: input.digest,
        role: input.role,
        scope: input.scope ?? "",
        path: input.path ?? null,
        mediaType: input.mediaType ?? null,
        sizeBytes: input.sizeBytes ?? 0,
        metadata: input.metadata ?? {},
        deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(200);
    expect(upsertScope).toBe("hoot_lib-1.2.3-py3-none-any.whl");
  });

  test("releases the blob ref and reports a 409 when the file already exists on the release", async () => {
    const ctx = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: "hoot-lib",
      namespace: null,
      metadata: {},
      latestVersion: "1.2.3",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let releasedDigest: string | undefined;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => ({
      digest: `sha256:${"c".repeat(64)}`,
      size: 11,
      deduped: false,
      refCreated: true,
      blobRefId: "blob_ref_dup",
    });
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const outcome = patch({
        id: "ver_1",
        metadata: {
          name: "hoot_lib",
          files: [
            {
              filename: "hoot_lib-1.2.3-py3-none-any.whl",
              blobDigest: `sha256:${"e".repeat(64)}`,
              sha256: "e".repeat(64),
              size: 11,
            },
          ],
        },
        deletedAt: null,
      });
      return outcome.result;
    };
    ctx.data.content.releaseBlobRef = async ({ digest }) => {
      releasedDigest = digest;
    };
    ctx.data.assets.upsert = () => {
      throw new Error("should not upsert an asset when the file already exists");
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(409);
    expect(releasedDigest).toBe(`sha256:${"c".repeat(64)}`);
    await expect(res.json()).resolves.toEqual({ message: "File already exists." });
  });

  test("reports a version conflict when the row is deleted during patch", async () => {
    const ctx = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: "hoot-lib",
      namespace: null,
      metadata: {},
      latestVersion: "1.2.3",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    ctx.data.assets.findByScope = async () => null;
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => ({
      digest: `sha256:${"d".repeat(64)}`,
      size: 11,
      deduped: false,
      refCreated: false,
      blobRefId: "blob_ref_d",
    });
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const outcome = patch({
        id: "ver_1",
        metadata: {},
        deletedAt: new Date("2026-02-01T00:00:00.000Z"),
      });
      return outcome.result;
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ message: "Release version already exists." });
  });
});
