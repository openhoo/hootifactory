import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RegistryStoredBlob } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { gemFilename, handleGemPush } from "./rubygems-publish-lifecycle";

const GEMSPEC = `--- !ruby/object:Gem::Specification
name: hooty
version: !ruby/object:Gem::Version
  version: 1.0.0
platform: ruby
dependencies:
- !ruby/object:Gem::Dependency
  name: json
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '2.0'
  type: :runtime
description: test
`;

function gemBytes(): Uint8Array {
  const metaGz = Bun.gzipSync(new TextEncoder().encode(GEMSPEC));
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode("metadata.gz"), 0);
  header.set(new TextEncoder().encode(`${metaGz.byteLength.toString(8).padStart(11, "0")}\0`), 124);
  header[156] = 0x30;
  const padded = Math.ceil(metaGz.byteLength / 512) * 512;
  const tar = new Uint8Array(512 + padded + 1024);
  tar.set(header, 0);
  tar.set(metaGz, 512);
  return tar;
}

function packageRow(): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name: "hooty",
    namespace: null,
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

describe("handleGemPush", () => {
  test("stores the gem with compact-index metadata and a filename-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow();
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async () => stored;
    const captured: {
      metadata?: Record<string, unknown>;
      assetRole?: string;
      assetScope?: string;
    } = {};
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      captured.metadata = input.metadata;
      captured.assetRole = input.asset?.role;
      captured.assetScope = input.asset?.scope;
      return { versionId: "ver_1" };
    };

    const res = await handleGemPush(
      new Request("https://registry.test/api/v1/gems", { method: "POST", body: gemBytes() }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(captured.metadata?.index).toEqual({
      name: "hooty",
      version: "1.0.0",
      deps: [{ name: "json", requirements: "~> 2.0" }],
      yanked: false,
    });
    expect(captured.metadata?.sha256).toBe("d".repeat(64));
    expect(captured.assetRole).toBe("rubygems_gem");
    expect(captured.assetScope).toBe(gemFilename("hooty", "1.0.0"));
  });

  test("rejects a re-push of an existing version with 409", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow();
    ctx.data.versions.find = async () =>
      ({ id: "ver_1", packageId: "pkg_1", version: "1.0.0" }) as never;
    ctx.data.content.storeBlobWithRef = async () => stored;

    const res = await handleGemPush(
      new Request("https://registry.test/api/v1/gems", { method: "POST", body: gemBytes() }),
      ctx,
    );
    expect(res.status).toBe(409);
  });

  test("rejects an unparseable upload with 422", async () => {
    const ctx = createTestRegistryContext();
    const res = await handleGemPush(
      new Request("https://registry.test/api/v1/gems", {
        method: "POST",
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      ctx,
    );
    expect(res.status).toBe(422);
  });
});
