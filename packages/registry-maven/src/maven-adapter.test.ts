import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryPackageVersionNameRow,
} from "@hootifactory/registry";
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

  test("generates maven-metadata.xml server-side from version rows", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("com.example:app");
      return {
        id: "pkg_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        name,
        namespace: "com.example",
        metadata: {},
        latestVersion: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      } satisfies RegistryPackageRow;
    };
    const versions: RegistryPackageVersionNameRow[] = [
      { version: "2.0.0" },
      { version: "1.1.0" },
      { version: "1.0.0" },
    ];
    ctx.data.versions.listLiveNames = async (pkg, opts) => {
      expect(pkg.name).toBe("com.example:app");
      expect(opts?.orderByCreated).toBe("desc");
      return versions;
    };
    const res = await new MavenAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: "com/example/app/maven-metadata.xml" },
      ),
      new Request("https://r.test/maven/o/r/com/example/app/maven-metadata.xml"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml");
    const body = await res.text();
    expect(body).toContain("<groupId>com.example</groupId>");
    expect(body).toContain("<artifactId>app</artifactId>");
    expect(body).toContain("<latest>2.0.0</latest>");
    expect(body).toContain("<release>2.0.0</release>");
    expect(body).toContain("<version>2.0.0</version>");
    expect(body).toContain("<version>1.1.0</version>");
    expect(body).toContain("<version>1.0.0</version>");
    expect(body).toMatch(/<lastUpdated>\d{14}<\/lastUpdated>/);
  });

  test("release picks the latest non-SNAPSHOT version", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () =>
      ({
        id: "pkg_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        name: "com.example:app",
        namespace: "com.example",
        metadata: {},
        latestVersion: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }) satisfies RegistryPackageRow;
    ctx.data.versions.listLiveNames = async () => [
      { version: "2.0.0-SNAPSHOT" },
      { version: "1.1.0" },
      { version: "1.0.0" },
    ];
    const res = await new MavenAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: "com/example/app/maven-metadata.xml" },
      ),
      new Request("https://r.test/maven/o/r/com/example/app/maven-metadata.xml"),
      ctx,
    );
    const body = await res.text();
    expect(body).toContain("<latest>2.0.0-SNAPSHOT</latest>");
    expect(body).toContain("<release>1.1.0</release>");
  });

  test("falls back to stored blob when no package exists for maven-metadata.xml", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ scope }) => assetRow(scope);
    ctx.data.content.blobRefExists = async () => true;
    const res = await new MavenAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: "com/unknown/app/maven-metadata.xml" },
      ),
      new Request("https://r.test/maven/o/r/com/unknown/app/maven-metadata.xml"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("blob:");
  });

  test("generates metadata for deep groupIds with multiple segments", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("org.springframework.boot:spring-boot-starter");
      return {
        id: "pkg_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        name,
        namespace: "org.springframework.boot",
        metadata: {},
        latestVersion: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      } satisfies RegistryPackageRow;
    };
    ctx.data.versions.listLiveNames = async () => [{ version: "3.0.0" }];
    const res = await new MavenAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        {
          path: "org/springframework/boot/spring-boot-starter/maven-metadata.xml",
        },
      ),
      new Request(
        "https://r.test/maven/o/r/org/springframework/boot/spring-boot-starter/maven-metadata.xml",
      ),
      ctx,
    );
    const body = await res.text();
    expect(body).toContain("<groupId>org.springframework.boot</groupId>");
    expect(body).toContain("<artifactId>spring-boot-starter</artifactId>");
  });
});
