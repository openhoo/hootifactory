import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryStoredBlob,
  UpsertPackageVersionInput,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handleAptUpload } from "./apt-upload-lifecycle";
import { makeDeb } from "./deb-parse.test";

const CONTROL = `Package: hootpkg
Version: 1.0.0
Architecture: amd64
Maintainer: e2e <e2e@hooti.test>
Depends: libc6 (>= 2.2.5), libfoo | libbar
Description: test`;

const stored: RegistryStoredBlob = {
  digest: `sha256:${"d".repeat(64)}`,
  size: 10,
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

function setup(existing: RegistryAssetRow | null = null) {
  const ctx = createTestRegistryContext();
  const captured: {
    version?: UpsertPackageVersionInput;
    assetMeta?: Record<string, unknown>;
    scanName?: string;
  } = {};
  ctx.data.assets.findByScope = async () => existing;
  ctx.data.content.storeBlobWithRef = async () => stored;
  ctx.data.packages.findOrCreate = async ({ name }) => packageRow(name);
  ctx.data.versions.upsert = async (input) => {
    captured.version = input;
    return "ver_1";
  };
  ctx.data.assets.upsert = async (input) => {
    captured.assetMeta = input.metadata;
    captured.scanName = input.scanInput?.name;
    return {} as RegistryAssetRow;
  };
  return { ctx, captured };
}

const POOL = "pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb";

describe("handleAptUpload", () => {
  test("parses the .deb and projects a package/version + index metadata", async () => {
    const { ctx, captured } = setup();
    const res = await handleAptUpload({
      poolPath: POOL,
      suite: "stable",
      component: "main",
      req: new Request(`https://r.test/apt/o/r/${POOL}`, { method: "PUT", body: makeDeb(CONTROL) }),
      ctx,
    });
    expect(res.status).toBe(201);
    expect(captured.version?.package.name).toBe("hootpkg");
    expect(captured.version?.version).toBe("1.0.0");
    expect(captured.version?.metadata.deps).toEqual(["libc6", "libfoo"]);
    expect(captured.version?.metadata.suite).toBe("stable");
    expect(captured.assetMeta?.architecture).toBe("amd64");
    expect(captured.assetMeta?.component).toBe("main");
    expect(typeof captured.assetMeta?.controlText).toBe("string");
    expect(captured.assetMeta?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.scanName).toBe("hootpkg");
  });

  test("rejects xz/zstd control compression with 415", async () => {
    const { ctx } = setup();
    const res = await handleAptUpload({
      poolPath: POOL,
      suite: "stable",
      component: "main",
      req: new Request(`https://r.test/apt/o/r/${POOL}`, {
        method: "PUT",
        body: makeDeb(CONTROL, "xz"),
      }),
      ctx,
    });
    expect(res.status).toBe(415);
  });

  test("rejects a duplicate pool file with 409", async () => {
    const { ctx } = setup({ scope: POOL } as RegistryAssetRow);
    const res = await handleAptUpload({
      poolPath: POOL,
      suite: "stable",
      component: "main",
      req: new Request(`https://r.test/apt/o/r/${POOL}`, { method: "PUT", body: makeDeb(CONTROL) }),
      ctx,
    });
    expect(res.status).toBe(409);
  });
});
