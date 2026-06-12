import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryVersionMetadataRow,
} from "@hootifactory/registry";
import { createTestRegistryContext, createTestRouteMatch } from "@hootifactory/registry/testing";
import { buildVersionsBody, RubygemsAdapter, rubygemsRegistryPlugin } from "./rubygems-adapter";

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

function versionRow(version: string, metadata: unknown): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: "pkg_1",
    version,
    metadata,
    sizeBytes: 10,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function assetRow(overrides: Partial<RegistryAssetRow>): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: "pkg_1",
    packageVersionId: "ver_1",
    blobRefId: "ref_1",
    digest: "sha256:aaa",
    role: "rubygems_gem",
    scope: "hooty-1.0.0.gem",
    path: "hooty-1.0.0.gem",
    mediaType: "application/octet-stream",
    sizeBytes: 10,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("RubygemsAdapter", () => {
  test("declares the push, yank, compact-index, and download routes", () => {
    expect(new RubygemsAdapter().routes()).toEqual([
      { method: "POST", pattern: "/api/v1/gems", handlerId: "push" },
      { method: "DELETE", pattern: "/api/v1/gems/yank", handlerId: "yank" },
      { method: "GET", pattern: "/versions", handlerId: "compactVersions" },
      { method: "GET", pattern: "/names", handlerId: "compactNames" },
      { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
      { method: "GET", pattern: "/gems/:filename", handlerId: "download" },
    ]);
  });

  test("scopes permissions to the artifact or package", () => {
    const adapter = new RubygemsAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/gems/:filename", handlerId: "download" },
          { filename: "hooty-1.0.0.gem" },
        ),
      ),
    ).toEqual({ action: "read", resource: { type: "artifact", artifactRef: "hooty-1.0.0.gem" } });
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
          { gem: "hooty" },
        ),
      ),
    ).toEqual({ action: "read", resource: { type: "package", packageName: "hooty" } });
    expect(
      adapter.requiredPermission(
        "POST",
        createTestRouteMatch({ method: "POST", pattern: "/api/v1/gems", handlerId: "push" }, {}),
      ),
    ).toEqual({ action: "write" });
  });

  test("serves the compact info file for a known gem", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) => (name === "hooty" ? packageRow("hooty") : null);
    ctx.data.versions.listLive = async () => [
      versionRow("1.0.0", {
        index: { name: "hooty", version: "1.0.0", deps: [], yanked: false },
        sha256: "a".repeat(64),
      }),
    ];
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
        { gem: "hooty" },
      ),
      new Request("https://registry.test/info/hooty"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`---\n1.0.0 |checksum:${"a".repeat(64)}\n`);
  });

  test("returns 404 from compact info for an unknown gem", async () => {
    const ctx = createTestRegistryContext();
    const adapter = new RubygemsAdapter();
    await expect(
      adapter.handle(
        createTestRouteMatch(
          { method: "GET", pattern: "/info/:gem", handlerId: "compactInfo" },
          { gem: "nope" },
        ),
        new Request("https://registry.test/info/nope"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("downloads a stored gem via its filename-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("rubygems_gem");
      expect(scope).toBe("hooty-1.0.0.gem");
      return assetRow({ digest: "sha256:bbb" });
    };
    ctx.data.content.blobRefExists = async () => true;
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/gems/:filename", handlerId: "download" },
        { filename: "hooty-1.0.0.gem" },
      ),
      new Request("https://registry.test/gems/hooty-1.0.0.gem"),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  function metadataRow(
    name: string,
    version: string,
    createdAt: Date,
    extra: Record<string, unknown> = {},
  ): RegistryVersionMetadataRow {
    return {
      version,
      metadata: {
        index: { name, version, deps: [], yanked: false, ...extra },
        sha256: "a".repeat(64),
      },
      createdAt,
    } as RegistryVersionMetadataRow;
  }

  test("serves the compact versions document and caches it with an etag", async () => {
    const ctx = createTestRegistryContext();
    let listCalls = 0;
    ctx.data.versions.listRepositoryMetadata = async (opts) => {
      listCalls += 1;
      expect(opts?.liveOnly).toBe(true);
      return [metadataRow("hooty", "1.0.0", new Date("2026-02-01T00:00:00.000Z"))];
    };
    const adapter = new RubygemsAdapter();
    const match = createTestRouteMatch({
      method: "GET",
      pattern: "/versions",
      handlerId: "compactVersions",
    });
    const first = await adapter.handle(match, new Request("https://registry.test/versions"), ctx);
    expect(first.status).toBe(200);
    const body = await first.text();
    expect(body).toContain("hooty 1.0.0 ");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    // A second request within the TTL is served from cache (no extra DB read).
    const second = await adapter.handle(match, new Request("https://registry.test/versions"), ctx);
    expect(second.status).toBe(200);
    expect(listCalls).toBe(1);

    // A matching If-None-Match returns 304 from the cached etag.
    const cached = await adapter.handle(
      match,
      new Request("https://registry.test/versions", {
        headers: { "if-none-match": etag as string },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
    expect(listCalls).toBe(1);
  });

  test("lists sorted gem names from /names", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.listNames = async () => [{ name: "zeta" }, { name: "alpha" }] as never;
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch({ method: "GET", pattern: "/names", handlerId: "compactNames" }),
      new Request("https://registry.test/names"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("---\nalpha\nzeta\n");
  });

  test("yanks a live version and marks it in metadata", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => packageRow("hooty");
    ctx.data.versions.findLive = async () =>
      versionRow("1.0.0", { index: { name: "hooty", version: "1.0.0", yanked: false } });
    let updated: Record<string, unknown> | undefined;
    ctx.data.versions.updateMetadata = async (_row, metadata) => {
      updated = metadata as Record<string, unknown>;
    };
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch({
        method: "DELETE",
        pattern: "/api/v1/gems/yank",
        handlerId: "yank",
      }),
      new Request("https://registry.test/api/v1/gems/yank?gem_name=hooty&version=1.0.0", {
        method: "DELETE",
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Yanked gem: hooty (1.0.0)");
    expect((updated?.index as Record<string, unknown>).yanked).toBe(true);
  });

  test("reads yank parameters from a form-encoded body when absent from the query", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async (name) => (name === "hooty" ? packageRow("hooty") : null);
    ctx.data.versions.findLive = async () =>
      versionRow("2.0.0", { index: { name: "hooty", version: "2.0.0" } });
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch({
        method: "DELETE",
        pattern: "/api/v1/gems/yank",
        handlerId: "yank",
      }),
      new Request("https://registry.test/api/v1/gems/yank", {
        method: "DELETE",
        body: "gem_name=hooty&version=2.0.0",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when yank is missing required parameters", async () => {
    const ctx = createTestRegistryContext();
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch({
        method: "DELETE",
        pattern: "/api/v1/gems/yank",
        handlerId: "yank",
      }),
      new Request("https://registry.test/api/v1/gems/yank", { method: "DELETE" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("yank throws not-found when the gem or version is unknown", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    const adapter = new RubygemsAdapter();
    const run = adapter.handle(
      createTestRouteMatch({
        method: "DELETE",
        pattern: "/api/v1/gems/yank",
        handlerId: "yank",
      }),
      new Request("https://registry.test/api/v1/gems/yank?gem_name=ghost&version=1.0.0", {
        method: "DELETE",
      }),
      ctx,
    );
    await expect(run).rejects.toThrow();
  });

  test("push stores the gem and clears the versions cache on success", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findOrCreate = async () => packageRow("hooty");
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async () => ({
      digest: `sha256:${"d".repeat(64)}`,
      size: 100,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch({ method: "POST", pattern: "/api/v1/gems", handlerId: "push" }),
      new Request("https://registry.test/api/v1/gems", { method: "POST", body: gemBytes() }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Successfully registered gem: hooty");
  });

  test("rejects an empty push body with 400", async () => {
    const ctx = createTestRegistryContext();
    const adapter = new RubygemsAdapter();
    const res = await adapter.handle(
      createTestRouteMatch({ method: "POST", pattern: "/api/v1/gems", handlerId: "push" }),
      new Request("https://registry.test/api/v1/gems", {
        method: "POST",
        body: new Uint8Array(0),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

const gemspec = `--- !ruby/object:Gem::Specification
name: hooty
version: !ruby/object:Gem::Version
  version: 1.0.0
platform: ruby
dependencies: []
description: test
`;

function gemBytes(): Uint8Array {
  const metaGz = Bun.gzipSync(new TextEncoder().encode(gemspec));
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

describe("buildVersionsBody", () => {
  function metaRow(
    name: string,
    version: string,
    createdAt: Date,
    extra: Record<string, unknown> = {},
  ): RegistryVersionMetadataRow {
    return {
      version,
      metadata: {
        index: { name, version, deps: [], yanked: false, ...extra },
        sha256: "a".repeat(64),
      },
      createdAt,
    } as RegistryVersionMetadataRow;
  }

  test("groups versions by gem name, sorts gems, and uses the latest timestamp", () => {
    const body = buildVersionsBody([
      metaRow("beta", "1.0.0", new Date("2026-01-01T00:00:00.000Z")),
      metaRow("alpha", "2.0.0", new Date("2026-03-01T00:00:00.000Z")),
      metaRow("alpha", "1.0.0", new Date("2026-02-01T00:00:00.000Z")),
    ]);
    const lines = body.trim().split("\n");
    expect(lines[0]).toBe("created_at: 2026-03-01T00:00:00.000Z");
    expect(lines[1]).toBe("---");
    expect(lines[2]?.startsWith("alpha 1.0.0,2.0.0 ")).toBe(true);
    expect(lines[3]?.startsWith("beta 1.0.0 ")).toBe(true);
  });

  test("omits gems whose every version is yanked", () => {
    const body = buildVersionsBody([
      metaRow("ghost", "1.0.0", new Date("2026-01-01T00:00:00.000Z"), { yanked: true }),
    ]);
    expect(body).not.toContain("ghost");
  });

  test("ignores rows without a usable index entry and defaults the epoch timestamp", () => {
    const body = buildVersionsBody([
      { version: "1.0.0", metadata: {}, createdAt: new Date(0) } as RegistryVersionMetadataRow,
    ]);
    expect(body).toBe("created_at: 1970-01-01T00:00:00Z\n---\n");
  });
});

describe("rubygemsRegistryPlugin", () => {
  test("exposes module metadata and a gem dependency graph for scanning", () => {
    expect(rubygemsRegistryPlugin.displayName).toBe("RubyGems");
    expect(rubygemsRegistryPlugin.mountSegment).toBe("rubygems");
    expect(rubygemsRegistryPlugin.capabilities.virtualizable).toBe(true);
    const graph = rubygemsRegistryPlugin.scan?.dependencyGraph?.({
      metadata: {
        index: {
          deps: [{ name: "json", requirements: ">= 2.0" }, { name: "bad" }, "not-an-object"],
        },
      },
    });
    expect(graph?.deps).toEqual({ json: ">= 2.0" });
    expect(graph?.osvEcosystem).toBe("RubyGems");
    expect(graph?.purlType).toBe("gem");
  });

  test("returns an empty dependency graph when no deps are present", () => {
    const graph = rubygemsRegistryPlugin.scan?.dependencyGraph?.({ metadata: {} });
    expect(graph?.deps).toEqual({});
  });
});
