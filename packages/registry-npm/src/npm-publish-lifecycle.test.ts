import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RegistryPackageVersionRow } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { buildNpmPublishedDist, handleNpmPublish } from "./npm-publish-lifecycle";

function attachment(data = "tarball-bytes") {
  return { data: Buffer.from(data).toString("base64") };
}

function publishRequest(body: unknown): Request {
  return new Request("https://registry.test/pkg", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function pkgRow(id: string, name: string, namespace: string | null = null): RegistryPackageRow {
  return {
    id,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  packageId: string,
  version: string,
  metadata: unknown,
): RegistryPackageVersionRow {
  return {
    id: `${packageId}_${version}`,
    orgId: "org_1",
    packageId,
    version,
    metadata,
    sizeBytes: 7,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("buildNpmPublishedDist", () => {
  test("builds publish dist metadata with scoped package tarball paths", () => {
    const tarball = new TextEncoder().encode("package bytes");
    const built = buildNpmPublishedDist({
      packageName: "@scope/pkg",
      version: "1.2.3",
      tarball,
      blobDigest: "sha256:abc",
      baseUrl: "https://registry.test",
      mountPath: "npm/acme/packages",
    });

    expect(built.manifestDist.tarball).toBe(
      "https://registry.test/npm/acme/packages/%40scope%2Fpkg/-/pkg-1.2.3.tgz",
    );
    expect(built.manifestDist.shasum).toMatch(/^[a-f0-9]{40}$/);
    expect(built.manifestDist.integrity).toStartWith("sha512-");
    expect(built.dist).toMatchObject({
      filename: "pkg-1.2.3.tgz",
      blobDigest: "sha256:abc",
      size: tarball.length,
    });
  });
});

describe("handleNpmPublish: parse failures", () => {
  test("returns the parse error status when the payload is invalid", async () => {
    const ctx = createTestRegistryContext();
    const res = await handleNpmPublish(
      "pkg",
      publishRequest({ name: "other", versions: {}, _attachments: {} }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "package name in body does not match URL" });
  });
});

describe("handleNpmPublish: tarball publish", () => {
  test("stores the blob, commits the version, sets dist-tags and latest", async () => {
    const ctx = createTestRegistryContext();
    const created = pkgRow("pkg_1", "pkg");
    let storeCalls = 0;
    const committed: Array<{ version: string; scope: string }> = [];
    const tagSets: Array<[string, string]> = [];
    const latest: Array<string | null> = [];

    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async (input) => {
      expect(input).toEqual({ name: "pkg", namespace: null });
      return created;
    };
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (input) => {
      storeCalls += 1;
      expect(input.kind).toBe("npm_tarball");
      expect(input.scope).toBe("pkg@1.0.0");
      return {
        digest: `sha256:${"a".repeat(64)}`,
        size: input.data.byteLength,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.push({ version: input.version, scope: input.scope });
      expect(input.package.id).toBe("pkg_1");
      expect(input.scan).toMatchObject({ name: "pkg", version: "1.0.0" });
      return { versionId: "ver_1" };
    };
    ctx.data.tags.set = async (_pkg, tag, row) => {
      tagSets.push([tag, row.version]);
    };
    ctx.data.tags.updateLatestVersion = async (_pkg, version) => {
      latest.push(version);
    };

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": { description: "first" } },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
      }),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true });
    expect(storeCalls).toBe(1);
    expect(committed).toEqual([{ version: "1.0.0", scope: "pkg@1.0.0" }]);
    expect(tagSets).toEqual([["latest", "1.0.0"]]);
    expect(latest).toEqual(["1.0.0"]);
  });

  test("rejects republishing a version that already exists", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.exists = async (_pkg, version) => version === "1.0.0";

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": {} },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
      }),
      ctx,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "cannot publish over the previously published version 1.0.0",
    });
  });

  test("returns 403 when the commit reports a conflict", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (input) => ({
      digest: `sha256:${"b".repeat(64)}`,
      size: input.data.byteLength,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ conflict: true });

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": {} },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
      }),
      ctx,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "cannot publish over the previously published version 1.0.0",
    });
  });

  test("returns 400 when a dist-tag points to an unknown version outside the publish", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.findLive = async () => null;

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": {} },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
        "dist-tags": { beta: "9.9.9" },
      }),
      ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "dist-tag beta points to an unknown version" });
  });

  test("creates a namespace from the scoped package name", async () => {
    const ctx = createTestRegistryContext();
    const createInputs: Array<{ name: string; namespace?: string | null }> = [];
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async (input) => {
      createInputs.push(input);
      return pkgRow("pkg_1", "@scope/pkg", "@scope");
    };
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (input) => ({
      digest: `sha256:${"c".repeat(64)}`,
      size: input.data.byteLength,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });
    ctx.data.tags.set = async () => {};
    ctx.data.tags.updateLatestVersion = async () => {};

    const res = await handleNpmPublish(
      "@scope/pkg",
      publishRequest({
        versions: { "1.0.0": { name: "@scope/pkg", version: "1.0.0" } },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
      }),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(createInputs).toEqual([{ name: "@scope/pkg", namespace: "@scope" }]);
  });
});

describe("handleNpmPublish: metadata-only publish", () => {
  test("returns 400 when no versions are provided", async () => {
    const ctx = createTestRegistryContext();
    const res = await handleNpmPublish(
      "pkg",
      publishRequest({ versions: {}, "dist-tags": {} }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "publish payload must include a version" });
  });

  test("returns 400 when the package does not exist", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    const res = await handleNpmPublish(
      "pkg",
      publishRequest({ versions: { "1.0.0": { deprecated: "old" } } }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing tarball attachment for 1.0.0" });
  });

  test("returns 404 when the targeted version is not live", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkgRow("pkg_1", "pkg");
    ctx.data.versions.listLive = async () => [];

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({ versions: { "1.0.0": { deprecated: "old" } } }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "version not found: 1.0.0" });
  });

  test("applies a deprecation patch and sets the latest dist-tag", async () => {
    const ctx = createTestRegistryContext();
    const pkg = pkgRow("pkg_1", "pkg");
    const upserted: Array<{ version: string; deprecated: unknown }> = [];
    const tagSets: Array<[string, string]> = [];
    const latest: Array<string | null> = [];

    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("pkg_1", "1.0.0", { manifest: { name: "pkg", version: "1.0.0" } }),
    ];
    ctx.data.versions.upsert = async (input) => {
      const manifest = (input.metadata as { manifest: { deprecated: unknown } }).manifest;
      upserted.push({ version: input.version, deprecated: manifest.deprecated });
      return "ver_updated";
    };
    ctx.data.tags.set = async (_pkg, tag, row) => {
      tagSets.push([tag, row.version]);
    };
    ctx.data.tags.updateLatestVersion = async (_pkg, version) => {
      latest.push(version);
    };

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": { deprecated: "no longer maintained" } },
        "dist-tags": { latest: "1.0.0" },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(upserted).toEqual([{ version: "1.0.0", deprecated: "no longer maintained" }]);
    expect(tagSets).toEqual([["latest", "1.0.0"]]);
    expect(latest).toEqual(["1.0.0"]);
  });

  test("skips the upsert when the metadata patch is a no-op but still applies dist-tags", async () => {
    const ctx = createTestRegistryContext();
    const pkg = pkgRow("pkg_1", "pkg");
    let upserts = 0;
    const tagSets: Array<[string, string]> = [];

    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("pkg_1", "1.0.0", { manifest: { name: "pkg", version: "1.0.0" } }),
    ];
    ctx.data.versions.upsert = async () => {
      upserts += 1;
      return "ver";
    };
    ctx.data.tags.set = async (_pkg, tag, row) => {
      tagSets.push([tag, row.version]);
    };

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        // No "deprecated" key -> patch is a no-op (metadata undefined).
        versions: { "1.0.0": { description: "ignored for metadata-only" } },
        "dist-tags": { beta: "1.0.0" },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(upserts).toBe(0);
    expect(tagSets).toEqual([["beta", "1.0.0"]]);
  });

  test("resolves a dist-tag for a live version not present in the publish entries", async () => {
    const ctx = createTestRegistryContext();
    const pkg = pkgRow("pkg_1", "pkg");
    const tagSets: Array<[string, string]> = [];

    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("pkg_1", "1.0.0", { manifest: { name: "pkg", version: "1.0.0" } }),
    ];
    ctx.data.versions.upsert = async () => "ver_updated";
    ctx.data.versions.findLive = async (_pkg, version) =>
      version === "2.0.0"
        ? versionRow("pkg_1", "2.0.0", { manifest: { name: "pkg", version: "2.0.0" } })
        : null;
    ctx.data.tags.set = async (_pkg, tag, row) => {
      tagSets.push([tag, row.version]);
    };

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": { deprecated: "x" } },
        "dist-tags": { stable: "2.0.0" },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(tagSets).toEqual([["stable", "2.0.0"]]);
  });

  test("returns 400 when a metadata-only dist-tag points to an unknown version", async () => {
    const ctx = createTestRegistryContext();
    const pkg = pkgRow("pkg_1", "pkg");

    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("pkg_1", "1.0.0", { manifest: { name: "pkg", version: "1.0.0" } }),
    ];
    ctx.data.versions.upsert = async () => "ver_updated";
    ctx.data.versions.findLive = async () => null;

    const res = await handleNpmPublish(
      "pkg",
      publishRequest({
        versions: { "1.0.0": { deprecated: "x" } },
        "dist-tags": { stable: "9.9.9" },
      }),
      ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "dist-tag stable points to an unknown version" });
  });
});
