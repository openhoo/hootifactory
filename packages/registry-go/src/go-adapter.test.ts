import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { GoAdapter } from "./go-adapter";
import { goModuleZip, goUploadRequest } from "./go-zip.fixtures";

const ZIP_DIGEST = `sha256:${"a".repeat(64)}`;

function versionRow(
  version: string,
  metadata: Record<string, unknown>,
  createdAt = new Date("2026-01-02T00:00:00.000Z"),
): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_1",
    version,
    metadata,
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function goMatch(handlerId: string, params: Record<string, string>, path: string): RouteMatch {
  const pattern =
    handlerId === "list"
      ? "/:module+/@v/list"
      : handlerId === "latest"
        ? "/:module+/@latest"
        : handlerId === "upload"
          ? "/:module+/@v/:version"
          : "/:module+/@v/:file";
  const method = handlerId === "upload" ? "PUT" : "GET";
  return { entry: { method, pattern, handlerId }, params, path };
}

const listMatch = {
  entry: { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
  params: { module: "example.com/acme/mod" },
  path: "/example.com/acme/mod/@v/list",
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "example.com/acme/mod",
  namespace: null,
  metadata: {},
  latestVersion: "v1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

describe("Go adapter contract", () => {
  test("declares the GOPROXY route surface", () => {
    const routes = new GoAdapter().routes();

    expect(routes).toEqual([
      { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
      { method: "GET", pattern: "/:module+/@latest", handlerId: "latest" },
      { method: "GET", pattern: "/:module+/@v/:file", handlerId: "file" },
      { method: "PUT", pattern: "/:module+/@v/:version", handlerId: "upload" },
    ]);
  });

  test("uses read permissions for reads and write permissions for uploads", () => {
    const adapter = new GoAdapter();

    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("HEAD")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge()).toEqual({ header: 'Basic realm="hootifactory"', status: 401 });
  });

  test("@v/list uses live version names without loading metadata", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "go", mountPath: "go/private" };
    let nameReads = 0;
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.versions.listLive = async () => {
      throw new Error("Go @v/list should not load full version metadata");
    };
    ctx.data.versions.listLiveNames = async (row, opts) => {
      nameReads += 1;
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [{ version: "v1.0.0" }, { version: "v0.0.0-20260101000000-abcdefabcdef" }];
    };

    const res = await new GoAdapter().handle(
      listMatch,
      new Request("https://registry.test/example.com/acme/mod/@v/list"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("v1.0.0\n");
    expect(nameReads).toBe(1);
  });

  test("@v/list 404s for an unknown module so the client falls through the proxy chain", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new GoAdapter().handle(
        listMatch,
        new Request("https://registry.test/example.com/acme/mod/@v/list"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("scopes zip-file permissions to the artifact and other module routes to the package", () => {
    const adapter = new GoAdapter();
    expect(
      adapter.requiredPermission("GET", {
        entry: { method: "GET", pattern: "/:module+/@v/:file", handlerId: "file" },
        params: { module: "example.com/acme/mod", file: "v1.0.0.zip" },
        path: "/example.com/acme/mod/@v/v1.0.0.zip",
      }),
    ).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "example.com/acme/mod",
        artifactRef: "example.com/acme/mod@v1.0.0.zip",
      },
    });
    expect(
      adapter.requiredPermission("GET", {
        entry: { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
        params: { module: "example.com/acme/mod" },
        path: "/example.com/acme/mod/@v/list",
      }),
    ).toEqual({
      action: "read",
      resource: { type: "package", packageName: "example.com/acme/mod" },
    });
  });

  test("@latest serves the highest non-pseudo version with its stored publish time", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("v1.0.0", {
        mod: "module x\n",
        zipSize: 1,
        zipDigest: ZIP_DIGEST,
        time: "2026-01-01T00:00:00.000Z",
      }),
      versionRow("v1.2.0", {
        mod: "module x\n",
        zipSize: 1,
        zipDigest: ZIP_DIGEST,
        time: "2026-01-02T00:00:00.000Z",
      }),
    ];

    const res = await new GoAdapter().handle(
      goMatch("latest", { module: "example.com/acme/mod" }, "/example.com/acme/mod/@latest"),
      new Request("https://registry.test/example.com/acme/mod/@latest"),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      Version: "v1.2.0",
      Time: "2026-01-02T00:00:00.000Z",
    });
  });

  test("@latest 404s when no stored version carries readable metadata", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [];
    await expect(
      new GoAdapter().handle(
        goMatch("latest", { module: "example.com/acme/mod" }, "/example.com/acme/mod/@latest"),
        new Request("https://registry.test/example.com/acme/mod/@latest"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("@v/<version>.info returns the version timestamp document", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("v1.0.0", {
        mod: "module x\n",
        zipSize: 1,
        zipDigest: ZIP_DIGEST,
        time: "2026-01-05T00:00:00.000Z",
      });

    const res = await new GoAdapter().handle(
      goMatch(
        "file",
        { module: "example.com/acme/mod", file: "v1.0.0.info" },
        "/example.com/acme/mod/@v/v1.0.0.info",
      ),
      new Request("https://registry.test/example.com/acme/mod/@v/v1.0.0.info"),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      Version: "v1.0.0",
      Time: "2026-01-05T00:00:00.000Z",
    });
  });

  test("@v/<version>.mod returns the stored go.mod text", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("v1.0.0", {
        mod: "module example.com/acme/mod\n\nrequire golang.org/x/text v0.3.0\n",
        zipSize: 1,
        zipDigest: ZIP_DIGEST,
        time: "2026-01-05T00:00:00.000Z",
      });

    const res = await new GoAdapter().handle(
      goMatch(
        "file",
        { module: "example.com/acme/mod", file: "v1.0.0.mod" },
        "/example.com/acme/mod/@v/v1.0.0.mod",
      ),
      new Request("https://registry.test/example.com/acme/mod/@v/v1.0.0.mod"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toContain("require golang.org/x/text v0.3.0");
  });

  test("@v/<version>.zip serves the stored blob", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () =>
      versionRow("v1.0.0", {
        mod: "module x\n",
        zipSize: 1,
        zipDigest: ZIP_DIGEST,
        time: "2026-01-05T00:00:00.000Z",
      });
    ctx.data.content.blobRefExists = async () => true;

    const res = await new GoAdapter().handle(
      goMatch(
        "file",
        { module: "example.com/acme/mod", file: "v1.0.0.zip" },
        "/example.com/acme/mod/@v/v1.0.0.zip",
      ),
      new Request("https://registry.test/example.com/acme/mod/@v/v1.0.0.zip"),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  test("@v/<version> with an unsupported file extension is rejected as a bad name", async () => {
    const ctx = createTestRegistryContext();
    // The version-file schema only accepts .info/.mod/.zip suffixes; anything else
    // is rejected up front as an invalid Go version file.
    await expect(
      new GoAdapter().handle(
        goMatch(
          "file",
          { module: "example.com/acme/mod", file: "v1.0.0.txt" },
          "/example.com/acme/mod/@v/v1.0.0.txt",
        ),
        new Request("https://registry.test/example.com/acme/mod/@v/v1.0.0.txt"),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NAME_INVALID" });
  });

  test("file 404s when the module has no package record", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new GoAdapter().handle(
        goMatch(
          "file",
          { module: "example.com/acme/mod", file: "v1.0.0.info" },
          "/example.com/acme/mod/@v/v1.0.0.info",
        ),
        new Request("https://registry.test/example.com/acme/mod/@v/v1.0.0.info"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("PUT @v/<version> uploads a hosted module zip", async () => {
    const moduleName = "example.com/hoot";
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => ({ ...pkg, name });
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async () => ({
      digest: ZIP_DIGEST,
      size: 10,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });

    const res = await new GoAdapter().handle(
      goMatch("upload", { module: moduleName, version: "v1.2.3" }, `/${moduleName}/@v/v1.2.3`),
      goUploadRequest(goModuleZip(moduleName, "v1.2.3")),
      ctx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, module: moduleName, version: "v1.2.3" });
  });

  test("scan.dependencyGraph parses single-line and block require directives", () => {
    const scan = new GoAdapter().scan;
    expect(
      scan?.dependencyGraph?.({
        metadata: {
          mod: "module x\n\nrequire golang.org/x/text v0.3.0\n\nrequire (\n\t// comment\n\trsc.io/quote v1.5.2\n)\n",
          zipSize: 1,
          zipDigest: ZIP_DIGEST,
          time: "2026-01-05T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      deps: { "golang.org/x/text": "v0.3.0", "rsc.io/quote": "v1.5.2" },
      purlType: "golang",
    });
  });

  test("scan.referencedDigests surfaces the stored zip digest", () => {
    const scan = new GoAdapter().scan;
    expect(
      scan?.referencedDigests?.({
        mod: "module x\n",
        zipSize: 1,
        zipDigest: ZIP_DIGEST,
        time: "2026-01-05T00:00:00.000Z",
      }),
    ).toEqual([ZIP_DIGEST]);
  });
});
