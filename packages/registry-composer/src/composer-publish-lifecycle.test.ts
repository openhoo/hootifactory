import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RegistryStoredBlob } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handleComposerUpload } from "./composer-publish-lifecycle";
import { composerJsonEntry, makeStoreZip } from "./composer-zip.fixtures";

function packageRow(name: string): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: name.split("/")[0] ?? null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const stored: RegistryStoredBlob = {
  digest: `sha256:${"d".repeat(64)}`,
  size: 100,
  deduped: false,
  refCreated: true,
  blobRefId: "ref_1",
};

const widgetZip = makeStoreZip([
  composerJsonEntry({ name: "acme/widget", require: { php: ">=8.1" } }),
]);

describe("handleComposerUpload", () => {
  test("stores the dist with v2 metadata and a path-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow("acme/widget");
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async () => stored;
    const captured: { metadata?: Record<string, unknown>; assetScope?: string } = {};
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      captured.metadata = input.metadata;
      captured.assetScope = input.asset?.scope;
      return { versionId: "ver_1" };
    };

    const res = await handleComposerUpload(
      new Request("https://registry.test/composer/acme/repo/packages/acme/widget?version=1.0.0", {
        method: "PUT",
        body: widgetZip,
      }),
      ctx,
      "acme/widget",
    );

    expect(res.status).toBe(201);
    expect(captured.metadata?.name).toBe("acme/widget");
    expect(captured.metadata?.version).toBe("1.0.0");
    expect(captured.metadata?.require).toEqual({ php: ">=8.1" });
    expect((captured.metadata?.dist as { shasum?: string }).shasum).toMatch(/^[a-f0-9]{40}$/);
    expect(captured.assetScope).toBe("acme/widget/1.0.0.zip");
  });

  test("stores dev branch versions with slash-containing dist paths", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow("acme/widget");
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async () => stored;
    const captured: { assetScope?: string; version?: string } = {};
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      captured.assetScope = input.asset?.scope;
      captured.version = input.version;
      return { versionId: "ver_1" };
    };

    const res = await handleComposerUpload(
      new Request(
        "https://registry.test/composer/acme/repo/packages/acme/widget?version=dev-feature/foo",
        {
          method: "PUT",
          body: widgetZip,
        },
      ),
      ctx,
      "acme/widget",
    );

    expect(res.status).toBe(201);
    expect(captured.version).toBe("dev-feature/foo");
    expect(captured.assetScope).toBe("acme/widget/dev-feature/foo.zip");
  });

  test("rejects a name mismatch between the path and composer.json", async () => {
    const ctx = createTestRegistryContext();
    const res = await handleComposerUpload(
      new Request("https://registry.test/composer/acme/repo/packages/acme/other?version=1.0.0", {
        method: "PUT",
        body: widgetZip,
      }),
      ctx,
      "acme/other",
    );
    expect(res.status).toBe(400);
  });

  test("requires a version", async () => {
    const ctx = createTestRegistryContext();
    const noVersionZip = makeStoreZip([composerJsonEntry({ name: "acme/widget" })]);
    const res = await handleComposerUpload(
      new Request("https://registry.test/composer/acme/repo/packages/acme/widget", {
        method: "PUT",
        body: noVersionZip,
      }),
      ctx,
      "acme/widget",
    );
    expect(res.status).toBe(400);
  });
});
