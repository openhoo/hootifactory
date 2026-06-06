import { describe, expect, test } from "bun:test";
import type { RegistryAssetRow } from "@hootifactory/registry";
import { createTestRegistryContext, createTestRouteMatch } from "@hootifactory/registry/testing";
import { MavenAdapter } from "./maven-adapter";

function assetRow(scope: string): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: null,
    packageVersionId: null,
    blobRefId: "ref_1",
    digest: "sha256:bbb",
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

describe("MavenAdapter", () => {
  test("declares upload and download routes", () => {
    expect(new MavenAdapter().routes()).toEqual([
      { method: "PUT", pattern: "/:path+", handlerId: "upload" },
      { method: "GET", pattern: "/:path+", handlerId: "download" },
    ]);
  });

  test("scopes write permission to the package for artifact files", () => {
    const adapter = new MavenAdapter();
    expect(
      adapter.requiredPermission(
        "PUT",
        createTestRouteMatch(
          { method: "PUT", pattern: "/:path+", handlerId: "upload" },
          { path: "com/example/app/1.0.0/app-1.0.0.jar" },
        ),
      ),
    ).toEqual({ action: "write", resource: { type: "package", packageName: "com.example:app" } });
  });

  test("scopes metadata files to the artifact path", () => {
    const adapter = new MavenAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/:path+", handlerId: "download" },
          { path: "com/example/app/maven-metadata.xml" },
        ),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "com/example/app/maven-metadata.xml" },
    });
  });

  test("downloads a stored file via its path-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("maven_file");
      return assetRow(scope);
    };
    ctx.data.content.blobRefExists = async () => true;
    const res = await new MavenAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: "com/example/app/1.0.0/app-1.0.0.jar" },
      ),
      new Request("https://r.test/maven/o/r/com/example/app/1.0.0/app-1.0.0.jar"),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  test("references the pom and every binary digest a version owns", () => {
    const referenced = new MavenAdapter().scan?.referencedDigests;
    expect(referenced?.({})).toEqual([]);
    expect(referenced?.({ pomDigest: "sha256:pom" })).toEqual(["sha256:pom"]);
    expect(
      referenced?.({
        pomDigest: "sha256:pom",
        binaryDigests: ["sha256:jar", "sha256:war", "sha256:jar", 42],
      }),
    ).toEqual(["sha256:pom", "sha256:jar", "sha256:war"]);
  });

  test("raises not-found for a missing file (dispatch maps it to 404)", async () => {
    const ctx = createTestRegistryContext();
    const handling = new MavenAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: "com/example/app/1.0.0/missing-1.0.0.jar" },
      ),
      new Request("https://r.test/maven/o/r/com/example/app/1.0.0/missing-1.0.0.jar"),
      ctx,
    );
    await expect(handling).rejects.toMatchObject({ status: 404 });
  });
});
