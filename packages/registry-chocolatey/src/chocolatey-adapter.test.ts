import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { ChocolateyAdapter } from "./chocolatey-adapter";
import type { ChocolateyVersionMeta } from "./chocolatey-validation";
import { makeStoredZip } from "./testing/zip-fixture";

const digest = `sha256:${"a".repeat(64)}`;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "git",
  namespace: null,
  metadata: {},
  latestVersion: "2.43.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function versionRow(version: string, metadata: ChocolateyVersionMeta): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: pkg.id,
    version,
    metadata,
    sizeBytes: metadata.size,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function meta(version: string): ChocolateyVersionMeta {
  return {
    nupkgDigest: digest,
    packageHash: "hash==",
    packageHashAlgorithm: "SHA512",
    size: 4096,
    id: "git",
    version,
    title: "Git",
    authors: "Git Community",
    description: "VCS",
    tags: "git vcs",
    dependencies: [{ id: "chocolatey", range: "[0.10.3,)" }],
    listed: true,
  };
}

function ctxFor() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "chocolatey", mountPath: "chocolatey/private" };
  return ctx;
}

function match(
  entry: RouteMatch["entry"],
  params: Record<string, string>,
  path: string,
): RouteMatch {
  return { entry, params, path };
}

describe("Chocolatey adapter", () => {
  test("declares the OData v2 read, download, push, and unlist routes", () => {
    expect(new ChocolateyAdapter().routes()).toEqual([
      { method: "GET", pattern: "/api/v2", handlerId: "serviceDoc" },
      { method: "GET", pattern: "/api/v2/", handlerId: "serviceDoc" },
      { method: "GET", pattern: "/api/v2/$metadata", handlerId: "metadata" },
      { method: "GET", pattern: "/api/v2/Packages()", handlerId: "packages" },
      { method: "GET", pattern: "/api/v2/Packages", handlerId: "packages" },
      { method: "GET", pattern: "/api/v2/FindPackagesById()", handlerId: "findById" },
      { method: "GET", pattern: "/api/v2/Search()", handlerId: "search", searchable: true },
      { method: "GET", pattern: "/api/v2/package/:id/:version", handlerId: "download" },
      { method: "PUT", pattern: "/api/v2/package", handlerId: "publish" },
      { method: "DELETE", pattern: "/api/v2/package/:id/:version", handlerId: "unlist" },
      { method: "GET", pattern: "/api/v2/:resource", handlerId: "packageEntry" },
    ]);
  });

  test("uses read/write permissions and refines package + artifact resources", () => {
    const adapter = new ChocolateyAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(
      adapter.requiredPermission(
        "GET",
        match(
          { method: "GET", pattern: "/api/v2/package/:id/:version", handlerId: "download" },
          { id: "Git", version: "2.43.0" },
          "/api/v2/package/Git/2.43.0",
        ),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "artifact", packageName: "git", artifactRef: "git.2.43.0.nupkg" },
    });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
    expect([...adapter.apiKeyHeaders]).toEqual(["x-nuget-apikey"]);
  });

  test("serves the AtomPub service document and EDMX metadata as XML", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    const service = await adapter.handle(
      match({ method: "GET", pattern: "/api/v2", handlerId: "serviceDoc" }, {}, "/api/v2"),
      new Request("https://registry.test/chocolatey/private/api/v2"),
      ctx,
    );
    expect(service.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await service.text()).toContain('<collection href="Packages">');

    const metadata = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/$metadata", handlerId: "metadata" },
        {},
        "/api/v2/$metadata",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/$metadata"),
      ctx,
    );
    expect(await metadata.text()).toContain('<EntityType Name="V2FeedPackage"');
  });

  test("FindPackagesById returns a feed of every stored version", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async (name) => (name === "git" ? pkg : null);
    ctx.data.versions.listLive = async () => [
      versionRow("2.42.0", meta("2.42.0")),
      versionRow("2.43.0", meta("2.43.0")),
    ];

    const res = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/FindPackagesById()", handlerId: "findById" },
        {},
        "/api/v2/FindPackagesById()",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/FindPackagesById()?id='git'"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/atom+xml;type=feed;charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<d:Version>2.42.0</d:Version>");
    expect(body).toContain("<d:Version>2.43.0</d:Version>");
    // Latest stable + absolute-latest is the 2.43.0 row.
    expect(body).toContain('<d:IsLatestVersion m:type="Edm.Boolean">true</d:IsLatestVersion>');
  });

  test("Packages(Id,Version) returns a single entry document", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [versionRow("2.43.0", meta("2.43.0"))];

    const res = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/:resource", handlerId: "packageEntry" },
        { resource: "Packages(Id='git',Version='2.43.0')" },
        "/api/v2/Packages(Id='git',Version='2.43.0')",
      ),
      new Request(
        "https://registry.test/chocolatey/private/api/v2/Packages(Id='git',Version='2.43.0')",
      ),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/atom+xml;type=entry;charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<entry xmlns=");
    expect(body).toContain("<d:Version>2.43.0</d:Version>");
  });

  test("Search() returns the latest stable match per package and excludes prereleases", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.list = async () => [
      { id: pkg.id, orgId: "org_1", repositoryId: "repo_1", name: "git" },
      { id: "pkg_2", orgId: "org_1", repositoryId: "repo_1", name: "vscode" },
    ];
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([
        [
          pkg.id,
          [
            versionRow("2.43.0", meta("2.43.0")),
            versionRow("2.44.0-beta.1", meta("2.44.0-beta.1")),
          ],
        ],
        [
          "pkg_2",
          [
            versionRow("1.85.0", {
              ...meta("1.85.0"),
              id: "vscode",
              title: "Visual Studio Code",
              description: "Code editor",
              tags: "editor ide",
            }),
          ],
        ],
      ]);

    const res = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/Search()", handlerId: "search", searchable: true },
        {},
        "/api/v2/Search()",
      ),
      new Request(
        "https://registry.test/chocolatey/private/api/v2/Search()?searchTerm='git'&includePrerelease=false",
      ),
      ctx,
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    // Substring match keeps only "git"; latest stable is 2.43.0, not the beta.
    expect(body).toContain("<d:Version>2.43.0</d:Version>");
    expect(body).not.toContain("2.44.0-beta.1");
    expect(body).not.toContain("vscode");
  });

  test("Search() matches the term against description/tags, not just the id", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.list = async () => [
      { id: pkg.id, orgId: "org_1", repositoryId: "repo_1", name: "git" },
    ];
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([
        [
          pkg.id,
          [
            versionRow("2.43.0", {
              ...meta("2.43.0"),
              description: "Distributed version control",
              tags: "scm cli",
            }),
          ],
        ],
      ]);

    const res = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/Search()", handlerId: "search", searchable: true },
        {},
        "/api/v2/Search()",
      ),
      new Request(
        "https://registry.test/chocolatey/private/api/v2/Search()?searchTerm='version control'",
      ),
      ctx,
    );

    const body = await res.text();
    // "git" does not contain the term, but its description does → still matched.
    expect(body).toContain("<d:Version>2.43.0</d:Version>");
  });

  test("download resolves the stored nupkg digest and streams the blob", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async (_pkg, version) =>
      version === "2.43.0" ? versionRow("2.43.0", meta("2.43.0")) : null;
    let askedFor: string | undefined;
    ctx.data.content.blobRefExists = async (input) => {
      askedFor = input.scope;
      return true;
    };

    const res = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/package/:id/:version", handlerId: "download" },
        { id: "git", version: "2.43.0" },
        "/api/v2/package/git/2.43.0",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/package/git/2.43.0"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(askedFor).toBe("git.2.43.0.nupkg");
    expect(await res.text()).toBe(`blob:${digest}`);
  });

  test("download 404s when the version is unknown", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => null;

    // Protocol 404s are thrown as RegistryError; the platform renders them per
    // errorResponseKind ("singleError" for Chocolatey).
    await expect(
      adapter.handle(
        match(
          { method: "GET", pattern: "/api/v2/package/:id/:version", handlerId: "download" },
          { id: "git", version: "9.9.9" },
          "/api/v2/package/git/9.9.9",
        ),
        new Request("https://registry.test/chocolatey/private/api/v2/package/git/9.9.9"),
        ctx,
      ),
    ).rejects.toThrow("not found");
  });

  test("publish stores a new version (201) and conflicts on a duplicate (409)", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    const bytes = makeStoredZip(
      "git.nuspec",
      "<package><metadata><id>Git</id><version>2.43.0</version></metadata></package>",
    );

    const stored: RegistryStoredBlob = {
      digest,
      size: bytes.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    };
    let committed: { version: string; metadata: Record<string, unknown> } | undefined;
    let existing = false;
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.versions.find = async () => (existing ? versionRow("2.43.0", meta("2.43.0")) : null);
    ctx.data.content.storeBlobWithRef = async () => stored;
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed = { version: input.version, metadata: input.metadata };
      return { versionId: "ver_new" };
    };

    const ok = await adapter.handle(
      match(
        { method: "PUT", pattern: "/api/v2/package", handlerId: "publish" },
        {},
        "/api/v2/package",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/package", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }),
      ctx,
    );

    expect(ok.status).toBe(201);
    expect(committed).toBeDefined();
    if (!committed) throw new Error("expected commit");
    expect(committed.version).toBe("2.43.0");
    expect(committed.metadata.nupkgDigest).toBe(digest);
    expect(committed.metadata.id).toBe("Git");
    expect(committed.metadata.size).toBe(bytes.length);

    existing = true;
    const conflict = await adapter.handle(
      match(
        { method: "PUT", pattern: "/api/v2/package", handlerId: "publish" },
        {},
        "/api/v2/package",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/package", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }),
      ctx,
    );
    expect(conflict.status).toBe(409);
  });

  test("Packages() feeds the absolute-latest version of every package", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.list = async () => [
      { id: pkg.id, orgId: "org_1", repositoryId: "repo_1", name: "git" },
      { id: "pkg_2", orgId: "org_1", repositoryId: "repo_1", name: "vscode" },
    ];
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([
        [pkg.id, [versionRow("2.42.0", meta("2.42.0")), versionRow("2.43.0", meta("2.43.0"))]],
        ["pkg_2", [versionRow("1.85.0", { ...meta("1.85.0"), id: "vscode" })]],
      ]);

    const res = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/Packages()", handlerId: "packages" },
        {},
        "/api/v2/Packages()",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/Packages()"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/atom+xml;type=feed;charset=utf-8");
    const body = await res.text();
    // One entry per package: the latest of git (2.43.0, not 2.42.0) plus vscode.
    expect(body).toContain("<d:Version>2.43.0</d:Version>");
    expect(body).not.toContain("<d:Version>2.42.0</d:Version>");
    expect(body).toContain("<d:Id>vscode</d:Id>");
    // Edm.DateTime is rendered timezone-less, without trailing Z or millis.
    expect(body).toContain('<d:Published m:type="Edm.DateTime">2026-01-02T00:00:00</d:Published>');
  });

  test("unlist flips listed:false on the stored version and returns 204", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async (name) => (name === "git" ? pkg : null);
    ctx.data.versions.findLive = async (_pkg, version) =>
      version === "2.43.0" ? versionRow("2.43.0", meta("2.43.0")) : null;
    let updated: { handle: unknown; metadata: Record<string, unknown> } | undefined;
    ctx.data.versions.updateMetadata = async (handle, metadata) => {
      updated = { handle, metadata };
    };

    const res = await adapter.handle(
      match(
        { method: "DELETE", pattern: "/api/v2/package/:id/:version", handlerId: "unlist" },
        { id: "Git", version: "2.43.0" },
        "/api/v2/package/Git/2.43.0",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/package/Git/2.43.0", {
        method: "DELETE",
      }),
      ctx,
    );

    expect(res.status).toBe(204);
    expect(updated).toBeDefined();
    expect(updated?.metadata.listed).toBe(false);
    // Other metadata is preserved alongside the listed flag flip.
    expect(updated?.metadata.id).toBe("git");
    expect(updated?.metadata.nupkgDigest).toBe(digest);
  });

  test("unlist 404s when the version is unknown", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => null;

    await expect(
      adapter.handle(
        match(
          { method: "DELETE", pattern: "/api/v2/package/:id/:version", handlerId: "unlist" },
          { id: "git", version: "9.9.9" },
          "/api/v2/package/git/9.9.9",
        ),
        new Request("https://registry.test/chocolatey/private/api/v2/package/git/9.9.9", {
          method: "DELETE",
        }),
        ctx,
      ),
    ).rejects.toThrow("not found");
  });

  test("FindPackagesById lists unlisted versions but excludes them from latest", async () => {
    const adapter = new ChocolateyAdapter();
    const ctx = ctxFor();
    ctx.data.packages.findByName = async () => pkg;
    // 2.44.0 is the newest version but is unlisted; the listed 2.43.0 must keep
    // IsLatestVersion (NuGet excludes unlisted from the latest computation).
    ctx.data.versions.listLive = async () => [
      versionRow("2.43.0", meta("2.43.0")),
      versionRow("2.44.0", { ...meta("2.44.0"), listed: false }),
    ];

    const feed = await adapter.handle(
      match(
        { method: "GET", pattern: "/api/v2/FindPackagesById()", handlerId: "findById" },
        {},
        "/api/v2/FindPackagesById()",
      ),
      new Request("https://registry.test/chocolatey/private/api/v2/FindPackagesById()?id='git'"),
      ctx,
    );
    const feedBody = await feed.text();
    // All versions are listed by FindPackagesById, including the unlisted one.
    expect(feedBody).toContain("<d:Version>2.43.0</d:Version>");
    expect(feedBody).toContain("<d:Version>2.44.0</d:Version>");
    // The listed 2.43.0 keeps IsLatestVersion; the unlisted 2.44.0 does not get it.
    const latestEntry = feedBody.slice(feedBody.indexOf("<d:Version>2.43.0</d:Version>"));
    expect(latestEntry).toContain(
      '<d:IsLatestVersion m:type="Edm.Boolean">true</d:IsLatestVersion>',
    );
    const unlistedEntry = feedBody.slice(feedBody.indexOf("<d:Version>2.44.0</d:Version>"));
    expect(unlistedEntry).toContain(
      '<d:IsLatestVersion m:type="Edm.Boolean">false</d:IsLatestVersion>',
    );
  });
});
