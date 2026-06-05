import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryStoredBlob,
  UpsertPackageVersionInput,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handleMavenUpload } from "./maven-upload-lifecycle";

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
    namespace: name.split(":")[0] ?? null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function assetRow(scope: string): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: null,
    packageVersionId: null,
    blobRefId: "ref_1",
    digest: stored.digest,
    role: "maven_file",
    scope,
    path: scope,
    mediaType: null,
    sizeBytes: 10,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const POM = `<project><groupId>com.example</groupId><artifactId>app</artifactId><version>1.0.0</version>
<dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>33.0.0-jre</version></dependency></dependencies>
</project>`;

function setup() {
  const ctx = createTestRegistryContext();
  const captured: {
    assetScopes: string[];
    version?: UpsertPackageVersionInput;
    scanName?: string;
  } = { assetScopes: [] };
  ctx.data.content.storeBlobWithRef = async () => stored;
  ctx.data.assets.upsert = async (input) => {
    captured.assetScopes.push(input.scope ?? "");
    return assetRow(input.scope ?? "");
  };
  ctx.data.packages.findOrCreate = async ({ name }) => packageRow(name);
  ctx.data.versions.upsert = async (input) => {
    captured.version = input;
    return "ver_1";
  };
  ctx.enqueueScan = async (input) => {
    captured.scanName = input.name;
  };
  return { ctx, captured };
}

describe("handleMavenUpload", () => {
  test("projects a package/version with parsed deps from the primary pom", async () => {
    const { ctx, captured } = setup();
    const res = await handleMavenUpload(
      "com/example/app/1.0.0/app-1.0.0.pom",
      new Request("https://r.test/maven/o/r/com/example/app/1.0.0/app-1.0.0.pom", {
        method: "PUT",
        body: POM,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(captured.assetScopes).toEqual(["com/example/app/1.0.0/app-1.0.0.pom"]);
    expect(captured.version?.package.name).toBe("com.example:app");
    expect(captured.version?.version).toBe("1.0.0");
    expect(captured.version?.metadata.deps).toEqual({ "com.google.guava:guava": "33.0.0-jre" });
    expect(captured.scanName).toBe("com.example:app");
  });

  test("stores non-pom files without projecting a version", async () => {
    const { ctx, captured } = setup();
    const res = await handleMavenUpload(
      "com/example/app/1.0.0/app-1.0.0.jar",
      new Request("https://r.test/maven/o/r/com/example/app/1.0.0/app-1.0.0.jar", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(captured.assetScopes).toEqual(["com/example/app/1.0.0/app-1.0.0.jar"]);
    expect(captured.version).toBeUndefined();
    expect(captured.scanName).toBeUndefined();
  });

  test("stores maven-metadata.xml as a plain file", async () => {
    const { ctx, captured } = setup();
    await handleMavenUpload(
      "com/example/app/maven-metadata.xml",
      new Request("https://r.test/maven/o/r/com/example/app/maven-metadata.xml", {
        method: "PUT",
        body: "<metadata/>",
      }),
      ctx,
    );
    expect(captured.assetScopes).toEqual(["com/example/app/maven-metadata.xml"]);
    expect(captured.version).toBeUndefined();
  });
});
