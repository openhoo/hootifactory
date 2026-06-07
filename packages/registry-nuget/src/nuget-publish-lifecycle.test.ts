import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RegistryStoredBlob } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { buildNugetPublishedMetadata, handleNugetPublish } from "./nuget-publish-lifecycle";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function makeStoredZip(filename: string, content: string): Uint8Array {
  const name = new TextEncoder().encode(filename);
  const data = new TextEncoder().encode(content);
  const local = [
    ...u32(0x04034b50),
    ...u16(20),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(data.byteLength),
    ...u32(data.byteLength),
    ...u16(name.byteLength),
    ...u16(0),
    ...name,
    ...data,
  ];
  const centralOffset = local.length;
  const central = [
    ...u32(0x02014b50),
    ...u16(20),
    ...u16(20),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(data.byteLength),
    ...u32(data.byteLength),
    ...u16(name.byteLength),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(0),
    ...name,
  ];
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u16(1),
    ...u32(central.length),
    ...u32(centralOffset),
    ...u16(0),
  ];
  return new Uint8Array([...local, ...central, ...end]);
}

function nupkg(input: { id?: string; version?: string } = {}): Uint8Array {
  const id = input.id ?? "Example.Lib";
  const version = input.version ?? "1.2.3";
  return makeStoredZip(
    `${id}.nuspec`,
    `<package><metadata><id>${id}</id><version>${version}</version></metadata></package>`,
  );
}

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

const stored: RegistryStoredBlob = {
  digest: `sha256:${"e".repeat(64)}`,
  size: 100,
  deduped: false,
  refCreated: true,
  blobRefId: "ref_1",
};

describe("NuGet publish lifecycle helpers", () => {
  test("stores the nupkg digest without dropping parsed metadata", () => {
    expect(
      buildNugetPublishedMetadata(
        {
          metadata: {
            file: "hoot.lib.1.2.3.nupkg",
            displayId: "Hoot.Lib",
            listed: true,
            semVer2: false,
            dependencyGroups: [{ targetFramework: "net8.0", dependencies: [] }],
          },
        },
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual({
      file: "hoot.lib.1.2.3.nupkg",
      displayId: "Hoot.Lib",
      listed: true,
      semVer2: false,
      dependencyGroups: [{ targetFramework: "net8.0", dependencies: [] }],
      nupkgDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});

describe("handleNugetPublish", () => {
  test("stores an immutable version and reports 201 with the nupkg digest", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow("example.lib");
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async () => stored;
    const captured: { metadata?: Record<string, unknown>; scope?: string; version?: string } = {};
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      captured.metadata = input.metadata;
      captured.scope = input.asset?.scope;
      captured.version = input.version;
      return { versionId: "ver_1" };
    };

    const res = await handleNugetPublish(
      new Request("https://registry.test/v3/package?id=Example.Lib&version=1.2.3", {
        method: "PUT",
        body: nupkg(),
      }),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(captured.version).toBe("1.2.3");
    expect(captured.scope).toBe("example.lib.1.2.3.nupkg");
    expect(captured.metadata?.nupkgDigest).toBe(stored.digest);
    expect(captured.metadata?.displayId).toBe("Example.Lib");
  });

  test("returns the parse error status when the request is invalid", async () => {
    const ctx = createTestRegistryContext();
    const res = await handleNugetPublish(
      new Request("https://registry.test/v3/package", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "could not determine package id and version" });
  });

  test("rejects a re-push of an existing version with 409", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow("example.lib");
    ctx.data.versions.find = async () => ({
      id: "ver_existing",
      orgId: "org_1",
      packageId: "pkg_1",
      version: "1.2.3",
      metadata: {},
      sizeBytes: 1,
      publishedByUserId: null,
      publishedByTokenId: null,
      deletedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    ctx.data.content.storeBlobWithRef = async () => {
      throw new Error("should not store bytes when the version already exists");
    };

    const res = await handleNugetPublish(
      new Request("https://registry.test/v3/package?id=Example.Lib&version=1.2.3", {
        method: "PUT",
        body: nupkg(),
      }),
      ctx,
    );
    expect(res.status).toBe(409);
  });
});
