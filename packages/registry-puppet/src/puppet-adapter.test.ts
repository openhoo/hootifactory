import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { PuppetAdapter } from "./puppet-adapter";
import { puppetArchive } from "./puppet-tarball.test";
import type { PuppetReleaseMeta } from "./puppet-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);
const MD5 = "b".repeat(32);

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: "puppetlabs",
    metadata: {},
    latestVersion: "1.2.3",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function releaseMeta(version: string): PuppetReleaseMeta {
  return {
    version,
    metadata: {
      name: "puppetlabs-apache",
      version,
      summary: "Apache module",
      license: "Apache-2.0",
      dependencies: [{ name: "puppetlabs/stdlib", version_requirement: ">= 4.0.0" }],
    },
    blobDigest: DIGEST,
    fileSha256: HEX,
    fileMd5: MD5,
    fileSize: 4,
    published: "2026-01-02T00:00:00.000Z",
  };
}

function versionRow(version: string, metadata: PuppetReleaseMeta): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_puppetlabs-apache",
    version,
    metadata,
    sizeBytes: 4,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function puppetContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "puppet", mountPath: "puppet/private" };
  return ctx;
}

function uploadRequest(archive: Uint8Array): Request {
  const form = new FormData();
  form.append("file", new File([archive], "module.tar.gz"), "module.tar.gz");
  return new Request("https://registry.test/puppet/private/v3/releases", {
    method: "POST",
    body: form,
  });
}

const moduleMatch = {
  entry: {
    method: "GET",
    pattern: "/v3/modules/:slug",
    handlerId: "module",
  },
  params: { slug: "puppetlabs-apache" },
  path: "/v3/modules/puppetlabs-apache",
} satisfies RouteMatch;

const releaseMatch = {
  entry: { method: "GET", pattern: "/v3/releases/:release", handlerId: "release" },
  params: { release: "puppetlabs-apache-1.2.3" },
  path: "/v3/releases/puppetlabs-apache-1.2.3",
} satisfies RouteMatch;

const releaseListMatch = {
  entry: { method: "GET", pattern: "/v3/releases", handlerId: "releaseList" },
  params: {},
  path: "/v3/releases",
} satisfies RouteMatch;

const fileMatch = {
  entry: { method: "GET", pattern: "/v3/files/:filename", handlerId: "file" },
  params: { filename: "puppetlabs-apache-1.2.3.tar.gz" },
  path: "/v3/files/puppetlabs-apache-1.2.3.tar.gz",
} satisfies RouteMatch;

const publishMatch = {
  entry: { method: "POST", pattern: "/v3/releases", handlerId: "publish" },
  params: {},
  path: "/v3/releases",
} satisfies RouteMatch;

describe("Puppet adapter", () => {
  test("declares Forge v3 routes with the literal /v3/releases before the catch-all", () => {
    expect(new PuppetAdapter().routes()).toEqual([
      { method: "GET", pattern: "/v3/releases", handlerId: "releaseList" },
      { method: "POST", pattern: "/v3/releases", handlerId: "publish" },
      { method: "GET", pattern: "/v3/releases/:release", handlerId: "release" },
      { method: "GET", pattern: "/v3/files/:filename", handlerId: "file" },
      {
        method: "GET",
        pattern: "/v3/modules/:slug",
        handlerId: "module",
        proxyRefreshTrigger: true,
        metadataMergeable: true,
        packageParam: "slug",
      },
    ]);
  });

  test("advertises proxy + virtual capabilities and a Bearer challenge", () => {
    const adapter = new PuppetAdapter();
    expect(adapter.capabilities.proxyable).toBe(true);
    expect(adapter.capabilities.virtualizable).toBe(true);
    expect(adapter.authChallenge().header).toBe('Bearer realm="hootifactory"');
  });

  test("uses read permissions for reads and write for publish", () => {
    const adapter = new PuppetAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    expect(adapter.requiredPermission("GET", { ...moduleMatch })).toEqual({
      action: "read",
      resource: { type: "package", packageName: "puppetlabs-apache" },
    });
    expect(adapter.requiredPermission("GET", { ...releaseMatch })).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "puppetlabs-apache",
        artifactRef: "puppetlabs-apache@1.2.3",
      },
    });
    expect(adapter.requiredPermission("GET", { ...fileMatch })).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "puppetlabs-apache",
        artifactRef: "puppetlabs-apache@1.2.3",
      },
    });
  });

  test("GET /v3/modules/:slug assembles the module JSON with current_release + releases", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("puppetlabs-apache");
      return pkgRow("puppetlabs-apache");
    };
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow("2.0.0", releaseMeta("2.0.0")), versionRow("1.2.3", releaseMeta("1.2.3"))];
    };

    const res = await new PuppetAdapter().handle(
      moduleMatch,
      new Request("https://registry.test/puppet/private/v3/modules/puppetlabs-apache"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      slug: string;
      name: string;
      owner: { username: string };
      current_release: { version: string; file_uri: string; file_sha256: string };
      releases: { version: string }[];
    };
    expect(body.slug).toBe("puppetlabs-apache");
    expect(body.name).toBe("apache");
    expect(body.owner.username).toBe("puppetlabs");
    expect(body.current_release.version).toBe("2.0.0");
    expect(body.current_release.file_uri).toBe(
      "https://registry.example.test/puppet/private/v3/files/puppetlabs-apache-2.0.0.tar.gz",
    );
    expect(body.current_release.file_sha256).toBe(HEX);
    // Releases are newest-first.
    expect(body.releases.map((r) => r.version)).toEqual(["2.0.0", "1.2.3"]);

    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    const cached = await new PuppetAdapter().handle(
      moduleMatch,
      new Request("https://registry.test/puppet/private/v3/modules/puppetlabs-apache", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /v3/modules/:slug 404s when the module has no live releases", async () => {
    const ctx = puppetContext();
    // findByName defaults to null → no releases → not found.
    const res = await new PuppetAdapter().handle(
      moduleMatch,
      new Request("https://registry.test/puppet/private/v3/modules/puppetlabs-apache"),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("puppetlabs-apache");
  });

  test("GET /v3/releases/:release serves the release detail with file hashes", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow("1.2.3", releaseMeta("1.2.3"));
    };

    const res = await new PuppetAdapter().handle(
      releaseMatch,
      new Request("https://registry.test/puppet/private/v3/releases/puppetlabs-apache-1.2.3"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      version: string;
      file_uri: string;
      file_md5: string;
      file_sha256: string;
      metadata: { name: string };
    };
    expect(body.slug).toBe("puppetlabs-apache-1.2.3");
    expect(body.version).toBe("1.2.3");
    expect(body.file_uri).toBe(
      "https://registry.example.test/puppet/private/v3/files/puppetlabs-apache-1.2.3.tar.gz",
    );
    expect(body.file_md5).toBe(MD5);
    expect(body.file_sha256).toBe(HEX);
    expect(body.metadata.name).toBe("puppetlabs-apache");
  });

  test("GET /v3/releases/:release 404s for an unknown version", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.findLive = async () => null;
    const res = await new PuppetAdapter().handle(
      releaseMatch,
      new Request("https://registry.test/puppet/private/v3/releases/puppetlabs-apache-1.2.3"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /v3/releases?module= returns the paginated release list envelope", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.listLive = async () => [
      versionRow("2.0.0", releaseMeta("2.0.0")),
      versionRow("1.2.3", releaseMeta("1.2.3")),
    ];

    const res = await new PuppetAdapter().handle(
      releaseListMatch,
      new Request(
        "https://registry.test/puppet/private/v3/releases?module=puppetlabs-apache&limit=1&offset=0",
      ),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pagination: { limit: number; offset: number; total: number; next: string | null };
      results: { version: string }[];
    };
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.next).toContain("offset=1");
    expect(body.results.map((r) => r.version)).toEqual(["2.0.0"]);
  });

  test("GET /v3/releases without a module query 400s", async () => {
    const ctx = puppetContext();
    const res = await new PuppetAdapter().handle(
      releaseListMatch,
      new Request("https://registry.test/puppet/private/v3/releases"),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("GET /v3/files/:filename serves the stored release tarball blob", async () => {
    const ctx = puppetContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow("1.2.3", releaseMeta("1.2.3"));
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("tarball-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new PuppetAdapter().handle(
      fileMatch,
      new Request("https://registry.test/puppet/private/v3/files/puppetlabs-apache-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("tarball-bytes");
  });

  test("GET /v3/files/:filename 404s when the requested version is not live", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    // findLive returns null for an unknown / non-live version.
    ctx.data.versions.findLive = async () => null;
    const res = await new PuppetAdapter().handle(
      {
        entry: { method: "GET", pattern: "/v3/files/:filename", handlerId: "file" },
        params: { filename: "puppetlabs-apache-9.9.9.tar.gz" },
        path: "/v3/files/puppetlabs-apache-9.9.9.tar.gz",
      },
      new Request("https://registry.test/puppet/private/v3/files/puppetlabs-apache-9.9.9.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /v3/files/:filename 404s (without throwing) when the blob ref is missing", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.findLive = async () => versionRow("1.2.3", releaseMeta("1.2.3"));
    // The release row exists, but its blob ref is absent (store not yet populated).
    ctx.data.content.blobRefExists = async () => false;
    const res = await new PuppetAdapter().handle(
      fileMatch,
      new Request("https://registry.test/puppet/private/v3/files/puppetlabs-apache-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("puppetlabs-apache-1.2.3.tar.gz");
  });

  test("GET /v3/files/:filename rejects a non-.tar.gz filename with 400", async () => {
    const ctx = puppetContext();
    const res = await new PuppetAdapter().handle(
      {
        entry: { method: "GET", pattern: "/v3/files/:filename", handlerId: "file" },
        params: { filename: "puppetlabs-apache-1.2.3.zip" },
        path: "/v3/files/puppetlabs-apache-1.2.3.zip",
      },
      new Request("https://registry.test/puppet/private/v3/files/puppetlabs-apache-1.2.3.zip"),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("scan.referencedDigests + dependencyGraph surface stored release data", () => {
    const adapter = new PuppetAdapter();
    const meta = { ...releaseMeta("1.2.3") } as unknown as Record<string, unknown>;
    expect(adapter.scan?.referencedDigests?.(meta)).toEqual([DIGEST]);
    expect(adapter.scan?.dependencyGraph?.({ metadata: meta })).toEqual({
      deps: { "puppetlabs/stdlib": ">= 4.0.0" },
      osvEcosystem: "Puppet",
      purlType: "puppet",
    });
  });

  test("POST /v3/releases publishes the module and stores derived metadata", async () => {
    const ctx = puppetContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown; name?: string } = {};
    ctx.data.packages.findByName = async () => null;
    ctx.data.versions.exists = async () => false;
    ctx.data.packages.findOrCreate = async ({ name }) => {
      committed.name = name;
      return pkgRow(name);
    };
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      expect(input.kind).toBe("puppet_release");
      expect(input.scope).toBe("puppetlabs-apache@1.2.3");
      return {
        digest: DIGEST,
        size: input.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const res = await new PuppetAdapter().handle(
      publishMatch,
      uploadRequest(puppetArchive("puppetlabs-apache", "1.2.3", { summary: "Apache module" })),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ slug: "puppetlabs-apache-1.2.3", version: "1.2.3" });
    expect(committed.name).toBe("puppetlabs-apache");
    expect(committed.scan).toEqual({
      name: "puppetlabs-apache",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      version: "1.2.3",
      blobDigest: DIGEST,
      fileSha256: HEX,
      fileSize: expect.any(Number),
    });
    expect((committed.metadata as { fileMd5: string }).fileMd5).toMatch(/^[a-f0-9]{32}$/);
  });

  test("POST /v3/releases returns 409 when the release already exists", async () => {
    const ctx = puppetContext();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.exists = async (_pkg, version) => version === "1.2.3";

    const res = await new PuppetAdapter().handle(
      publishMatch,
      uploadRequest(puppetArchive("puppetlabs-apache", "1.2.3")),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("puppetlabs-apache-1.2.3");
  });

  test("POST /v3/releases rejects a non-multipart body with 400", async () => {
    const ctx = puppetContext();
    const res = await new PuppetAdapter().handle(
      publishMatch,
      new Request("https://registry.test/puppet/private/v3/releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("generateMetadata + mergeMetadata union releases across virtual members", async () => {
    const ctx = puppetContext();
    const adapter = new PuppetAdapter();
    ctx.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx.data.versions.listLive = async () => [versionRow("1.2.3", releaseMeta("1.2.3"))];

    const a = await adapter.generateMetadata("puppetlabs-apache", ctx);
    expect(a).not.toBeNull();

    // A second member exposing a higher version.
    const ctx2 = puppetContext();
    ctx2.data.packages.findByName = async () => pkgRow("puppetlabs-apache");
    ctx2.data.versions.listLive = async () => [versionRow("2.0.0", releaseMeta("2.0.0"))];
    const b = await adapter.generateMetadata("puppetlabs-apache", ctx2);
    expect(b).not.toBeNull();
    if (!a || !b) throw new Error("expected metadata");

    const merged = await adapter.mergeMetadata([a, b]);
    const body = JSON.parse(merged.body as string) as {
      releases: { version: string }[];
      current_release: { version: string };
    };
    expect(body.releases.map((r) => r.version)).toEqual(["2.0.0", "1.2.3"]);
    expect(body.current_release.version).toBe("2.0.0");
  });
});
