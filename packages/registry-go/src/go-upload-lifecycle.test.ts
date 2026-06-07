import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RegistryStoredBlob } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  buildGoPublishedMetadata,
  goUploadSuccessResponse,
  goVersionConflictResponse,
  handleGoUpload,
} from "./go-upload-lifecycle";
import { goModuleZip, goUploadRequest } from "./go-zip.fixtures";

const MODULE = "example.com/hoot";

const stored: RegistryStoredBlob = {
  digest: `sha256:${"a".repeat(64)}`,
  size: 100,
  deduped: false,
  refCreated: true,
  blobRefId: "ref_1",
};

function packageRow(name: string): RegistryPackageRow {
  return {
    id: "pkg_1",
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

describe("Go upload lifecycle helpers", () => {
  test("stores the zip digest without dropping parsed upload metadata", () => {
    expect(
      buildGoPublishedMetadata(
        {
          metadata: {
            mod: "module example.com/hoot\n",
            zipSize: 42,
            time: "2026-01-02T03:04:05.000Z",
          },
        },
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual({
      mod: "module example.com/hoot\n",
      zipSize: 42,
      time: "2026-01-02T03:04:05.000Z",
      zipDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  test("keeps Go upload response shapes", async () => {
    await expect(goUploadSuccessResponse("example.com/hoot", "v1.2.3").json()).resolves.toEqual({
      ok: true,
      module: "example.com/hoot",
      version: "v1.2.3",
    });
    expect(goVersionConflictResponse().status).toBe(409);
    await expect(goVersionConflictResponse().json()).resolves.toEqual({
      error: "version already exists",
    });
  });
});

describe("handleGoUpload", () => {
  test("stores the module zip and projects version metadata + a go_zip asset", async () => {
    const ctx = createTestRegistryContext();
    const captured: {
      pkgName?: string;
      scope?: string;
      version?: string;
      metadata?: Record<string, unknown>;
      assetRole?: string;
      assetPath?: string | null;
    } = {};
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => {
      captured.pkgName = name;
      return packageRow(name);
    };
    ctx.data.content.storeBlobWithRef = async (input) => {
      captured.scope = input.scope;
      return stored;
    };
    ctx.data.versions.exists = async () => false;
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      captured.version = input.version;
      captured.metadata = input.metadata;
      captured.assetRole = input.asset?.role;
      captured.assetPath = input.asset?.path;
      return { versionId: "ver_1" };
    };

    const res = await handleGoUpload(MODULE, "v1.2.3", goUploadRequest(goModuleZip()), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, module: MODULE, version: "v1.2.3" });
    expect(captured.pkgName).toBe(MODULE);
    expect(captured.scope).toBe(`${MODULE}@v1.2.3.zip`);
    expect(captured.version).toBe("v1.2.3");
    expect(captured.assetRole).toBe("go_zip");
    expect(captured.assetPath).toBe("v1.2.3.zip");
    const meta = captured.metadata as { zipDigest: string; mod: string };
    expect(meta.zipDigest).toBe(stored.digest);
    expect(meta.mod).toBe(`module ${MODULE}\n`);
  });

  test("short-circuits with 409 when the package version already exists", async () => {
    const ctx = createTestRegistryContext();
    let stored409 = false;
    ctx.data.packages.findByName = async () => packageRow(MODULE);
    ctx.data.versions.exists = async () => true;
    ctx.data.content.storeBlobWithRef = async () => {
      stored409 = true;
      return stored;
    };

    const res = await handleGoUpload(MODULE, "v1.2.3", goUploadRequest(goModuleZip()), ctx);

    expect(res.status).toBe(409);
    // The duplicate is rejected before the blob is ever stored.
    expect(stored409).toBe(false);
  });

  test("rejects uploads whose zip fails Go module validation", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;

    const res = await handleGoUpload(
      MODULE,
      "v1.2.3",
      goUploadRequest(new TextEncoder().encode("not a zip")),
      ctx,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("invalid module zip"),
    });
  });

  test("returns 409 when the version conflict surfaces during commit", async () => {
    const ctx = createTestRegistryContext();
    // No existing package, so the pre-check is skipped; the conflict is detected
    // by versionConflict() inside publishImmutableVersionBlob.
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => packageRow(name);
    ctx.data.content.storeBlobWithRef = async () => stored;
    ctx.data.versions.exists = async () => true;
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });

    const res = await handleGoUpload(MODULE, "v1.2.3", goUploadRequest(goModuleZip()), ctx);

    expect(res.status).toBe(409);
  });
});
