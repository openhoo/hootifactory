import { describe, expect, test } from "bun:test";
import type {
  RegistryMetadata,
  RegistryPackageRow,
  RegistryPackageSummaryRow,
  RegistryPackageVersionRow,
  RegistryVirtualSearchInput,
  ResolvedRepo,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext, createTestResolvedRepo } from "@hootifactory/registry/testing";
import { NpmAdapter } from "./npm-adapter";

const whoamiMatch = {
  entry: { method: "GET", pattern: "/-/whoami", handlerId: "whoami" },
  params: {},
  path: "/-/whoami",
} satisfies RouteMatch;

const searchMatch = {
  entry: { method: "GET", pattern: "/-/v1/search", handlerId: "search" },
  params: {},
  path: "/-/v1/search",
} satisfies RouteMatch;

const packumentMatch = {
  entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
  params: { pkg: "pkg" },
  path: "pkg",
} satisfies RouteMatch;

const tarballMatch = {
  entry: { method: "GET", pattern: "/:pkg+/-/:filename", handlerId: "tarball" },
  params: { pkg: "@scope/pkg", filename: "pkg-1.2.3-beta.1.tgz" },
  path: "@scope/pkg/-/pkg-1.2.3-beta.1.tgz",
} satisfies RouteMatch;

function packageRow(id: string, name: string): RegistryPackageSummaryRow {
  return { id, orgId: "org_1", repositoryId: "repo_1", name };
}

function fullPackageRow(id: string, name: string): RegistryPackageRow {
  return {
    ...packageRow(id, name),
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  packageId: string,
  version: string,
  createdAt: Date,
): RegistryPackageVersionRow {
  return {
    id: `${packageId}_${version}`,
    orgId: "org_1",
    packageId,
    version,
    metadata: { manifest: { description: `${packageId} ${version}` } },
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("npm adapter contract", () => {
  test("whoami reports the token owner when token metadata is available", async () => {
    const res = await new NpmAdapter().handle(
      whoamiMatch,
      new Request("https://registry.test/-/whoami"),
      {
        principal: {
          kind: "token",
          tokenId: "tok_123",
          tokenName: "ci-token",
          orgId: "org_123",
          ownerUserId: "user_123",
          ownerUsername: "alice",
          grants: [],
          isRobot: false,
        },
      } as unknown as Parameters<NpmAdapter["handle"]>[2],
    );

    expect(await res.json()).toEqual({ username: "alice" });
  });

  test("whoami falls back to a stable token identity for unowned tokens", async () => {
    const res = await new NpmAdapter().handle(
      whoamiMatch,
      new Request("https://registry.test/-/whoami"),
      {
        principal: {
          kind: "token",
          tokenId: "tok_123",
          tokenName: "automation",
          orgId: "org_123",
          ownerUserId: null,
          ownerUsername: null,
          grants: [],
          isRobot: true,
        },
      } as unknown as Parameters<NpmAdapter["handle"]>[2],
    );

    expect(await res.json()).toEqual({ username: "automation" });
  });

  test("search batches version and dist-tag lookups", async () => {
    const packages = [packageRow("pkg_1", "alpha"), packageRow("pkg_2", "beta")];
    let perPackageVersionReads = 0;
    let perPackageTagReads = 0;
    let searchVersionReads = 0;
    let batchedTagReads = 0;
    const ctx = createTestRegistryContext();
    ctx.data.packages.search = async (input) => {
      expect(input).toEqual({ text: "", from: 0, size: 2 });
      return { packages, total: packages.length };
    };
    ctx.data.versions.listLive = async () => {
      perPackageVersionReads += 1;
      return [];
    };
    ctx.data.tags.listLive = async () => {
      perPackageTagReads += 1;
      return {};
    };
    ctx.data.versions.listSearchVersionsForPackages = async (
      pkgs,
      preferredVersionsByPackageId,
    ) => {
      searchVersionReads += 1;
      expect(pkgs.map((pkg) => pkg.id)).toEqual(["pkg_1", "pkg_2"]);
      expect([...preferredVersionsByPackageId]).toEqual([["pkg_1", "1.0.0"]]);
      return new Map([
        ["pkg_1", versionRow("pkg_1", "1.0.0", new Date("2026-01-02T00:00:00.000Z"))],
        ["pkg_2", versionRow("pkg_2", "0.1.0", new Date("2026-01-01T00:00:00.000Z"))],
      ]);
    };
    ctx.data.tags.listLiveForPackages = async (pkgs) => {
      batchedTagReads += 1;
      expect(pkgs.map((pkg) => pkg.id)).toEqual(["pkg_1", "pkg_2"]);
      return new Map<string, Record<string, string>>([
        ["pkg_1", { latest: "1.0.0" }],
        ["pkg_2", {}],
      ]);
    };

    const res = await new NpmAdapter().handle(
      searchMatch,
      new Request("https://registry.test/-/v1/search?size=2"),
      ctx,
    );
    const body = (await res.json()) as {
      objects: Array<{ package: { name: string; version: string } }>;
    };

    expect(body.objects.map((object) => [object.package.name, object.package.version])).toEqual([
      ["alpha", "1.0.0"],
      ["beta", "0.1.0"],
    ]);
    expect(perPackageVersionReads).toBe(0);
    expect(perPackageTagReads).toBe(0);
    expect(searchVersionReads).toBe(1);
    expect(batchedTagReads).toBe(1);
  });

  test("packument responses reuse cached bodies and etags", async () => {
    const adapter = new NpmAdapter();
    const ctx = createTestRegistryContext();
    let fullVersionReads = 0;
    let fingerprintReads = 0;

    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("pkg");
      return fullPackageRow("pkg_1", "pkg");
    };
    ctx.data.tags.listLive = async () => ({ latest: "1.0.0" });
    ctx.data.versions.listLiveFingerprints = async () => {
      fingerprintReads += 1;
      return [{ version: "1.0.0", updatedAt: new Date("2026-01-01T00:00:00.000Z") }];
    };
    ctx.data.versions.listLive = async () => {
      fullVersionReads += 1;
      return [
        {
          ...versionRow("pkg_1", "1.0.0", new Date("2026-01-01T00:00:00.000Z")),
          metadata: {
            manifest: { name: "pkg", version: "1.0.0", description: "cached" },
          },
        },
      ];
    };

    const first = await adapter.handle(
      packumentMatch,
      new Request("https://registry.test/pkg"),
      ctx,
    );
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^".+"$/);
    expect(await first.json()).toMatchObject({ description: "cached" });
    expect(fullVersionReads).toBe(1);

    if (!adapter.generateMetadata) throw new Error("expected npm metadata generator");
    const metadata = await adapter.generateMetadata("pkg", ctx);
    expect(JSON.parse(String(metadata?.body))).toMatchObject({ description: "cached" });
    expect(fullVersionReads).toBe(1);

    const cached = await adapter.handle(
      packumentMatch,
      new Request("https://registry.test/pkg", { headers: { "if-none-match": etag ?? "" } }),
      ctx,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(fullVersionReads).toBe(1);
    expect(fingerprintReads).toBe(3);
  });

  test("tarball lookup derives the version and avoids scanning live versions", async () => {
    const ctx = createTestRegistryContext();
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let lookedUpVersion = "";
    let blobScope = "";

    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("@scope/pkg");
      return fullPackageRow("pkg_1", "@scope/pkg");
    };
    ctx.data.versions.listLive = async () => {
      throw new Error("tarball lookup should not scan live versions");
    };
    ctx.data.versions.findLive = async (pkg, version) => {
      expect(pkg.id).toBe("pkg_1");
      lookedUpVersion = version;
      return {
        ...versionRow(pkg.id, version, new Date("2026-01-01T00:00:00.000Z")),
        metadata: {
          manifest: { name: "@scope/pkg", version },
          dist: {
            filename: "pkg-1.2.3-beta.1.tgz",
            blobDigest: digest,
            shasum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            integrity: "sha512-test",
            size: 12,
          },
        },
      };
    };
    ctx.data.content.blobRefExists = async (input) => {
      blobScope = input.scope;
      expect(input).toMatchObject({
        digest,
        kind: "npm_tarball",
        scope: "@scope/pkg@1.2.3-beta.1",
      });
      return true;
    };
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType, extraHeaders }) =>
      new Response(`blob:${digest}`, {
        headers: {
          ...extraHeaders,
          "content-type": contentType,
        },
      });

    const res = await new NpmAdapter().handle(
      tarballMatch,
      new Request("https://registry.test/@scope/pkg/-/pkg-1.2.3-beta.1.tgz"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
    await expect(res.text()).resolves.toBe(`blob:${digest}`);
    expect(lookedUpVersion).toBe("1.2.3-beta.1");
    expect(blobScope).toBe("@scope/pkg@1.2.3-beta.1");
  });

  test("tarball returns 404 when the package or dist is missing", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new NpmAdapter().handle(
        tarballMatch,
        new Request("https://registry.test/@scope/pkg/-/pkg-1.2.3-beta.1.tgz"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    const ctx2 = createTestRegistryContext();
    ctx2.data.packages.findByName = async () => fullPackageRow("pkg_1", "@scope/pkg");
    ctx2.data.versions.findLive = async () => null;
    await expect(
      new NpmAdapter().handle(
        tarballMatch,
        new Request("https://registry.test/@scope/pkg/-/pkg-1.2.3-beta.1.tgz"),
        ctx2,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("packument returns 404 when the package is unknown", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    await expect(
      new NpmAdapter().handle(packumentMatch, new Request("https://registry.test/pkg"), ctx),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("generateMetadata returns null for an unknown package", async () => {
    const adapter = new NpmAdapter();
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    if (!adapter.generateMetadata) throw new Error("expected metadata generator");
    expect(await adapter.generateMetadata("pkg", ctx)).toBeNull();
  });
});

describe("npm adapter permissions and scan", () => {
  const adapterForRoutes = new NpmAdapter();
  function matchFor(handlerId: string, params: Record<string, string> = {}): RouteMatch {
    const entry = adapterForRoutes.routes().find((route) => route.handlerId === handlerId);
    if (!entry) throw new Error(`no route for ${handlerId}`);
    return { entry, params, path: entry.pattern };
  }

  test("maps read/write actions and package/artifact resources", () => {
    const adapter = new NpmAdapter();
    const ctx = createTestRegistryContext();

    expect(adapter.requiredPermission("GET", matchFor("packument"), ctx)).toEqual({
      action: "read",
    });
    expect(adapter.requiredPermission("PUT", matchFor("publish"), ctx)).toEqual({
      action: "write",
    });
    // audit handlers stay read-only even on POST.
    expect(adapter.requiredPermission("POST", matchFor("auditBulk"), ctx)).toEqual({
      action: "read",
    });
    expect(
      adapter.requiredPermission("GET", matchFor("packument", { pkg: "left-pad" }), ctx),
    ).toEqual({ action: "read", resource: { type: "package", packageName: "left-pad" } });
    expect(
      adapter.requiredPermission(
        "GET",
        matchFor("tarball", { pkg: "left-pad", filename: "left-pad-1.0.0.tgz" }),
        ctx,
      ),
    ).toEqual({
      action: "read",
      resource: { type: "artifact", packageName: "left-pad", artifactRef: "left-pad-1.0.0.tgz" },
    });
  });

  test("derives the npm scan dependency graph from a stored manifest", () => {
    const adapter = new NpmAdapter();
    const result = adapter.scan?.dependencyGraph?.({
      metadata: {
        manifest: {
          dependencies: { "left-pad": "^1.0.0", ignored: 2 },
          devDependencies: { jest: "29" },
        },
      },
    });
    expect(result).toEqual({
      deps: { "left-pad": "^1.0.0", jest: "29" },
      osvEcosystem: "npm",
      purlType: "npm",
    });
  });

  test("reports the referenced tarball blob digest for retention", () => {
    const adapter = new NpmAdapter();
    const digest = `sha256:${"f".repeat(64)}`;
    expect(adapter.scan?.referencedDigests?.({ dist: { blobDigest: digest } })).toEqual([digest]);
  });
});

describe("npm adapter metadata merge", () => {
  test("merges packument parts into a single registry metadata body", async () => {
    const adapter = new NpmAdapter();
    if (!adapter.mergeMetadata) throw new Error("expected metadata merger");
    const parts: RegistryMetadata[] = [
      {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          name: "pkg",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { name: "pkg", version: "1.0.0" } },
        }),
      },
      {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          name: "pkg",
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": { name: "pkg", version: "2.0.0" } },
        }),
      },
    ];
    const merged = await adapter.mergeMetadata(parts, createTestRegistryContext());
    const body = JSON.parse(String(merged.body)) as { versions: Record<string, unknown> };
    expect(Object.keys(body.versions).sort()).toEqual(["1.0.0", "2.0.0"]);
  });

  test("search maps package rows to name-only items with the default size", async () => {
    const adapter = new NpmAdapter();
    if (!adapter.search) throw new Error("expected search hook");
    const ctx = createTestRegistryContext();
    ctx.data.packages.search = async (input) => {
      expect(input).toEqual({ text: "left", from: 0, size: 20 });
      return { packages: [packageRow("pkg_1", "left-pad")], total: 1 };
    };
    const result = await adapter.search({ text: "left" }, ctx);
    expect(result).toEqual({ items: [{ name: "left-pad" }], total: 1 });
  });
});

describe("npm adapter dist-tags routes", () => {
  const distTagsListMatch: RouteMatch = {
    entry: { method: "GET", pattern: "/-/package/:pkg+/dist-tags", handlerId: "distTagsList" },
    params: { pkg: "pkg" },
    path: "/-/package/pkg/dist-tags",
  };
  const distTagSetMatch: RouteMatch = {
    entry: { method: "PUT", pattern: "/-/package/:pkg+/dist-tags/:tag", handlerId: "distTagSet" },
    params: { pkg: "pkg", tag: "beta" },
    path: "/-/package/pkg/dist-tags/beta",
  };
  const distTagDeleteMatch: RouteMatch = {
    entry: {
      method: "DELETE",
      pattern: "/-/package/:pkg+/dist-tags/:tag",
      handlerId: "distTagDelete",
    },
    params: { pkg: "pkg", tag: "beta" },
    path: "/-/package/pkg/dist-tags/beta",
  };

  test("lists dist-tags for a known package and 404s an unknown one", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => fullPackageRow("pkg_1", "pkg");
    ctx.data.tags.listLive = async () => ({ latest: "1.0.0", beta: "1.1.0" });
    const res = await new NpmAdapter().handle(
      distTagsListMatch,
      new Request("https://registry.test/-/package/pkg/dist-tags"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latest: "1.0.0", beta: "1.1.0" });

    const missingCtx = createTestRegistryContext();
    missingCtx.data.packages.findByName = async () => null;
    await expect(
      new NpmAdapter().handle(
        distTagsListMatch,
        new Request("https://registry.test/-/package/pkg/dist-tags"),
        missingCtx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("distTagSet sets the tag and updates latest", async () => {
    const ctx = createTestRegistryContext();
    const tagSets: Array<[string, string]> = [];
    const latest: Array<string | null> = [];
    ctx.data.packages.findByName = async () => fullPackageRow("pkg_1", "pkg");
    ctx.data.versions.findLive = async (_pkg, version) =>
      versionRow("pkg_1", version, new Date("2026-01-01T00:00:00.000Z"));
    ctx.data.tags.set = async (_pkg, tag, row) => {
      tagSets.push([tag, row.version]);
    };
    ctx.data.tags.updateLatestVersion = async (_pkg, version) => {
      latest.push(version);
    };

    const beta = await new NpmAdapter().handle(
      distTagSetMatch,
      new Request("https://registry.test/-/package/pkg/dist-tags/beta", {
        method: "PUT",
        body: '"1.1.0"',
      }),
      ctx,
    );
    expect(beta.status).toBe(200);
    expect(await beta.json()).toEqual({ ok: true });
    expect(tagSets).toEqual([["beta", "1.1.0"]]);
    expect(latest).toEqual([]);

    const latestMatch: RouteMatch = {
      ...distTagSetMatch,
      params: { pkg: "pkg", tag: "latest" },
    };
    const setLatest = await new NpmAdapter().handle(
      latestMatch,
      new Request("https://registry.test/-/package/pkg/dist-tags/latest", {
        method: "PUT",
        body: '"2.0.0"',
      }),
      ctx,
    );
    expect(setLatest.status).toBe(200);
    expect(latest).toEqual(["2.0.0"]);
  });

  test("distTagSet 404s when the package or version is missing", async () => {
    const missingPkg = createTestRegistryContext();
    missingPkg.data.packages.findByName = async () => null;
    await expect(
      new NpmAdapter().handle(
        distTagSetMatch,
        new Request("https://registry.test/-/package/pkg/dist-tags/beta", {
          method: "PUT",
          body: '"1.1.0"',
        }),
        missingPkg,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    const missingVersion = createTestRegistryContext();
    missingVersion.data.packages.findByName = async () => fullPackageRow("pkg_1", "pkg");
    missingVersion.data.versions.findLive = async () => null;
    await expect(
      new NpmAdapter().handle(
        distTagSetMatch,
        new Request("https://registry.test/-/package/pkg/dist-tags/beta", {
          method: "PUT",
          body: '"1.1.0"',
        }),
        missingVersion,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("distTagDelete removes the tag and clears latest when deleting latest", async () => {
    const ctx = createTestRegistryContext();
    const deleted: string[] = [];
    let latestCleared = false;
    ctx.data.packages.findByName = async () => fullPackageRow("pkg_1", "pkg");
    ctx.data.tags.delete = async (_pkg, tag) => {
      deleted.push(tag);
    };
    ctx.data.tags.updateLatestVersion = async (_pkg, version) => {
      if (version === null) latestCleared = true;
    };

    const beta = await new NpmAdapter().handle(
      distTagDeleteMatch,
      new Request("https://registry.test/-/package/pkg/dist-tags/beta", { method: "DELETE" }),
      ctx,
    );
    expect(beta.status).toBe(200);
    expect(deleted).toEqual(["beta"]);
    expect(latestCleared).toBe(false);

    const latestMatch: RouteMatch = {
      ...distTagDeleteMatch,
      params: { pkg: "pkg", tag: "latest" },
    };
    const removeLatest = await new NpmAdapter().handle(
      latestMatch,
      new Request("https://registry.test/-/package/pkg/dist-tags/latest", { method: "DELETE" }),
      ctx,
    );
    expect(removeLatest.status).toBe(200);
    expect(latestCleared).toBe(true);

    const missingCtx = createTestRegistryContext();
    missingCtx.data.packages.findByName = async () => null;
    await expect(
      new NpmAdapter().handle(
        distTagDeleteMatch,
        new Request("https://registry.test/-/package/pkg/dist-tags/beta", { method: "DELETE" }),
        missingCtx,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("npm adapter publish and proxy delegation", () => {
  test("publish delegates to the publish lifecycle", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async () => fullPackageRow("pkg_1", "pkg");
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (input) => ({
      digest: `sha256:${"a".repeat(64)}`,
      size: input.data.byteLength,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });
    ctx.data.tags.set = async () => {};
    ctx.data.tags.updateLatestVersion = async () => {};

    const publishMatch: RouteMatch = {
      entry: { method: "PUT", pattern: "/:pkg+", handlerId: "publish" },
      params: { pkg: "pkg" },
      path: "pkg",
    };
    const res = await new NpmAdapter().handle(
      publishMatch,
      new Request("https://registry.test/pkg", {
        method: "PUT",
        body: JSON.stringify({
          versions: { "1.0.0": {} },
          _attachments: { "pkg-1.0.0.tgz": { data: Buffer.from("tgz").toString("base64") } },
        }),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
  });

  test("proxyIngest delegates to the proxy lifecycle and rejects invalid names", async () => {
    const adapter = new NpmAdapter();
    const ctx = createTestRegistryContext();
    if (!adapter.proxyIngest) throw new Error("expected proxyIngest");
    expect(await adapter.proxyIngest("INVALID NAME!", "https://registry.npmjs.org", ctx)).toBe(
      false,
    );
  });
});

describe("npm adapter virtual search", () => {
  test("merges member search bodies and adds a timestamp", async () => {
    const adapter = new NpmAdapter();
    if (!adapter.virtualSearch) throw new Error("expected virtualSearch");
    const member: ResolvedRepo = createTestResolvedRepo({ id: "member_1" });
    const ctx = createTestRegistryContext();
    const input: RegistryVirtualSearchInput = {
      req: new Request("https://registry.test/-/v1/search?text=left&size=5"),
      ctx,
      collectMemberResponses: async (requestForMember) => {
        const req = await requestForMember({
          req: new Request("https://registry.test/-/v1/search?text=left&size=5"),
          member,
        });
        expect(req).toBeInstanceOf(Request);
        return [
          {
            member,
            response: Response.json({
              objects: [{ package: { name: "left-pad", version: "1.0.0" } }],
              total: 1,
            }),
          },
          {
            // An errored member is ignored by the merge.
            member,
            response: Response.json({ error: "boom" }, { status: 500 }),
          },
        ];
      },
    };

    const res = await adapter.virtualSearch(input);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      objects: Array<{ package: { name: string } }>;
      time: string;
    };
    expect(body.objects.map((o) => o.package.name)).toEqual(["left-pad"]);
    expect(typeof body.time).toBe("string");
  });
});
