import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RegistryStoredBlob } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  buildCargoPublishedMetadata,
  cargoError,
  cargoPublishSuccessResponse,
  cargoVersionAlreadyPublished,
  handleCargoPublish,
} from "./cargo-publish-lifecycle";

const encoder = new TextEncoder();

function cargoPublishBody(metadata: object, crateBytes: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(metadata));
  const body = new Uint8Array(4 + json.length + 4 + crateBytes.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, json.length, true);
  body.set(json, 4);
  dv.setUint32(4 + json.length, crateBytes.length, true);
  body.set(crateBytes, 4 + json.length + 4);
  return body;
}

const stored: RegistryStoredBlob = {
  digest: `sha256:${"a".repeat(64)}`,
  size: 11,
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

function publishRequest(metadata: object, crate = "crate bytes"): Request {
  return new Request("https://registry.test/api/v1/crates/new", {
    method: "PUT",
    body: cargoPublishBody(metadata, encoder.encode(crate)),
  });
}

describe("Cargo publish lifecycle helpers", () => {
  test("detects duplicate versions by Cargo identity", () => {
    const versions = [{ version: "1.2.3+first" }, { version: "2.0.0" }];

    expect(cargoVersionAlreadyPublished(versions, "1.2.3+second")).toBe(true);
    expect(cargoVersionAlreadyPublished(versions, "1.2.4")).toBe(false);
  });

  test("stores sparse index metadata with the blob digest", () => {
    const index = {
      name: "demo_crate",
      vers: "1.2.3",
      deps: [],
      cksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      features: {},
      yanked: false,
    };

    expect(
      buildCargoPublishedMetadata(
        index,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toEqual({
      index,
      crateDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  test("keeps Cargo publish success response shape", async () => {
    await expect(cargoPublishSuccessResponse().json()).resolves.toEqual({
      warnings: { invalid_categories: [], invalid_badges: [], other: [] },
    });
  });

  test("renders Cargo error responses with the errors/detail envelope", async () => {
    const res = cargoError("version already exists", 409);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      errors: [{ detail: "version already exists" }],
    });
  });
});

describe("handleCargoPublish", () => {
  function setup() {
    const ctx = createTestRegistryContext();
    const captured: {
      pkgName?: string;
      scope?: string;
      version?: string;
      metadata?: Record<string, unknown>;
      assetPath?: string | null;
      scanMediaType?: string;
    } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => {
      captured.pkgName = name;
      return packageRow(name);
    };
    ctx.data.content.storeBlobWithRef = async (input) => {
      captured.scope = input.scope;
      return stored;
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      captured.version = input.version;
      captured.metadata = input.metadata;
      captured.assetPath = input.asset?.path;
      captured.scanMediaType = input.scan.mediaType;
      return { versionId: "ver_1" };
    };
    return { ctx, captured };
  }

  test("lowercases the crate name, stores the blob, and projects sparse-index metadata", async () => {
    const { ctx, captured } = setup();

    const res = await handleCargoPublish(
      publishRequest({ name: "Demo_Crate", vers: "1.2.3", deps: [], features: {} }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      warnings: { invalid_categories: [], invalid_badges: [], other: [] },
    });
    // Crate names canonicalize to lowercase for the package record and blob scope.
    expect(captured.pkgName).toBe("demo_crate");
    expect(captured.scope).toBe("demo_crate@1.2.3.crate");
    expect(captured.version).toBe("1.2.3");
    expect(captured.assetPath).toBe("demo_crate-1.2.3.crate");
    expect(captured.scanMediaType).toBe("application/octet-stream");
    const meta = captured.metadata as { index: { name: string }; crateDigest: string };
    // The published index entry preserves the original-case crate name (cargo serves it back).
    expect(meta.index.name).toBe("Demo_Crate");
    expect(meta.crateDigest).toBe(stored.digest);
  });

  test("returns 409 when a matching version already exists (ignoring build metadata)", async () => {
    const { ctx } = setup();
    let conflictCheckedFor: string | undefined;
    ctx.data.versions.listNames = async (pkg) => {
      conflictCheckedFor = pkg.id;
      return [{ version: "1.2.3+otherbuild" }];
    };

    const res = await handleCargoPublish(
      publishRequest({ name: "demo_crate", vers: "1.2.3+build.9", deps: [], features: {} }),
      ctx,
    );

    expect(conflictCheckedFor).toBe("pkg_1");
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      errors: [{ detail: "version already exists" }],
    });
  });
});
