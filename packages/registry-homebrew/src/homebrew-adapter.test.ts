import { describe, expect, test } from "bun:test";
import {
  RegistryError,
  type RegistryPackageRow,
  type RegistryPackageVersionRow,
  type RegistryStoredBlob,
  type RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { HomebrewAdapter } from "./homebrew-adapter";
import { buildHomebrewFormulaJson, type HomebrewFormulaJson } from "./homebrew-formula";
import {
  bottleFileName,
  bottleScope,
  isValidBottleFileName,
  isValidBottleTag,
  isValidFormulaName,
  isValidFormulaVersion,
  parseHomebrewVersionMeta,
  versionSizeBytes,
} from "./homebrew-validation";

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "hootcli",
  namespace: null,
  metadata: {},
  latestVersion: "1.2.3",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function versionRow(version: string, metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: pkg.id,
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

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const stableMeta = {
  desc: "A demo CLI",
  homepage: "https://example.test/hootcli",
  license: "MIT",
  bottles: {
    arm64_sonoma: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 11 },
    x86_64_linux: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 22 },
  },
};

const BASE = "https://registry.example.test/homebrew/private";

/** The full expected formula JSON for `stableMeta` at a given base/tap. */
function expectedFormula(base = BASE, tap = "homebrew/private") {
  return buildHomebrewFormulaJson({
    name: "hootcli",
    version: "1.2.3",
    metadata: { ...stableMeta },
    base,
    tap,
  });
}

function withHomebrewRepo(ctx = createTestRegistryContext()) {
  ctx.repo = { ...ctx.repo, moduleId: "homebrew", mountPath: "homebrew/private" };
  return ctx;
}

describe("Homebrew validation", () => {
  test("validates formula names, versions, and bottle tags", () => {
    expect(isValidFormulaName("hootcli")).toBe(true);
    expect(isValidFormulaName("foo-bar.baz+1")).toBe(true);
    expect(isValidFormulaName("openssl@3")).toBe(true);
    expect(isValidFormulaName("Bad/Name")).toBe(false);
    expect(isValidFormulaName("../escape")).toBe(false);

    expect(isValidFormulaVersion("1.2.3")).toBe(true);
    expect(isValidFormulaVersion("2.0.0-rc.1+build5")).toBe(true);
    expect(isValidFormulaVersion("bad version")).toBe(false);

    expect(isValidBottleTag("arm64_sonoma")).toBe(true);
    expect(isValidBottleTag("x86_64_linux")).toBe(true);
    expect(isValidBottleTag("Ventura")).toBe(false);
  });

  test("derives canonical bottle filenames and the scope is the filename", () => {
    const file = bottleFileName("hootcli", "1.2.3", "arm64_sonoma");
    expect(file).toBe("hootcli-1.2.3.arm64_sonoma.bottle.tar.gz");
    expect(bottleScope("hootcli", "1.2.3", "arm64_sonoma")).toBe(file);
  });

  test("derives unambiguous filenames for hyphenated (SemVer prerelease) versions", () => {
    // Regression: a `-` in the version must not corrupt the filename. The download
    // path resolves the blob by the whole filename (the asset scope), so the only
    // requirement is that the advertised filename is well-formed and stable.
    const file = bottleFileName("foo", "2.0.0-rc.1", "ventura");
    expect(file).toBe("foo-2.0.0-rc.1.ventura.bottle.tar.gz");
    expect(bottleScope("foo", "2.0.0-rc.1", "ventura")).toBe(file);
    expect(isValidBottleFileName(file)).toBe(true);
  });

  test("validates bottle filenames and rejects traversal / wrong suffixes", () => {
    expect(isValidBottleFileName("hootcli-1.2.3.arm64_sonoma.bottle.tar.gz")).toBe(true);
    expect(isValidBottleFileName("openssl@3-3.2.1.arm64_sonoma.bottle.tar.gz")).toBe(true);
    expect(isValidBottleFileName("foo-2.0.0-rc.1.ventura.bottle.tar.gz")).toBe(true);
    // Wrong suffix.
    expect(isValidBottleFileName("hootcli-1.2.3.tahoe.tar.gz")).toBe(false);
    expect(isValidBottleFileName("foo.bottle.tar.gz")).toBe(false);
    // Path traversal / separators.
    expect(isValidBottleFileName("../escape.arm64.bottle.tar.gz")).toBe(false);
    expect(isValidBottleFileName("a/b.arm64.bottle.tar.gz")).toBe(false);
    expect(isValidBottleFileName("a\\b.arm64.bottle.tar.gz")).toBe(false);
    // Just the suffix, no stem.
    expect(isValidBottleFileName(".bottle.tar.gz")).toBe(false);
  });

  test("computes a version's size as the sum of its bottle blob sizes", () => {
    const parsed = parseHomebrewVersionMeta(stableMeta);
    if (!parsed) throw new Error("expected stableMeta to parse");
    expect(versionSizeBytes(parsed)).toBe(33);
    // Bottles missing a recorded size contribute 0 (back-compat metadata).
    expect(
      versionSizeBytes({
        bottles: { ventura: { blobDigest: DIGEST, sha256: SHA256 } },
      }),
    ).toBe(0);
  });
});

describe("Homebrew adapter", () => {
  test("declares the formula index, formula, names, publish, and download routes", () => {
    expect(new HomebrewAdapter().routes()).toEqual([
      { method: "GET", pattern: "/api/formula.json", handlerId: "formulaIndex" },
      { method: "GET", pattern: "/api/formula_names.txt", handlerId: "formulaNames" },
      { method: "GET", pattern: "/api/formula/:name", handlerId: "formula" },
      { method: "PUT", pattern: "/api/formula/:name/:version/:tag", handlerId: "publish" },
      { method: "GET", pattern: "/bottles/:file", handlerId: "download" },
    ]);
  });

  test("maps reads to read permission and publishes to write permission", () => {
    const adapter = new HomebrewAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');

    // The download permission identifies the artifact by its full filename ref and
    // omits packageName: the `<name>-<ver>.<tag>` stem is ambiguous (both name and
    // version admit `-`/`.`), so guessing a packageName would point at the wrong
    // resource for hyphenated versions.
    const downloadMatch = {
      entry: { method: "GET", pattern: "/bottles/:file", handlerId: "download" },
      params: { file: bottleFileName("foo", "2.0.0-rc.1", "ventura") },
      path: "/bottles/foo-2.0.0-rc.1.ventura.bottle.tar.gz",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", downloadMatch)).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "foo-2.0.0-rc.1.ventura.bottle.tar.gz" },
    });

    // A malformed bottle filename yields a bare read permission (no resource hint).
    const badDownloadMatch = {
      entry: { method: "GET", pattern: "/bottles/:file", handlerId: "download" },
      params: { file: "../escape" },
      path: "/bottles/escape",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", badDownloadMatch)).toEqual({ action: "read" });

    const formulaMatch = {
      entry: { method: "GET", pattern: "/api/formula/:name", handlerId: "formula" },
      params: { name: "hootcli.json" },
      path: "/api/formula/hootcli.json",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", formulaMatch)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "hootcli" },
    });
  });

  test("serves a single formula object from the newest live bottled version", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("hootcli");
      return pkg;
    };
    ctx.data.versions.listLive = async (row, opts) => {
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow("1.2.3", stableMeta)];
    };

    const match = {
      entry: { method: "GET", pattern: "/api/formula/:name", handlerId: "formula" },
      params: { name: "hootcli.json" },
      path: "/api/formula/hootcli.json",
    } satisfies RouteMatch;
    const res = await new HomebrewAdapter().handle(
      match,
      new Request("https://registry.test/api/formula/hootcli.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = (await res.json()) as HomebrewFormulaJson;
    // The full brew-JSON-API object shape (top-level keys present so brew's
    // from_api install path never hits a missing key), built from the same helper.
    const expected = expectedFormula();
    expect(body).toEqual(expected);
    // Spot-check the load-bearing fields and the bottle files map.
    expect(body.name).toBe("hootcli");
    expect(body.tap).toBe("homebrew/private");
    expect(body.versions).toEqual({ stable: "1.2.3", head: null, bottle: true });
    expect(body.ruby_source_path).toBe("Formula/hootcli.rb");
    expect(body.bottle.stable.files).toEqual({
      arm64_sonoma: {
        cellar: "any",
        url: `${BASE}/bottles/hootcli-1.2.3.arm64_sonoma.bottle.tar.gz`,
        sha256: SHA256,
      },
      x86_64_linux: {
        cellar: "any",
        url: `${BASE}/bottles/hootcli-1.2.3.x86_64_linux.bottle.tar.gz`,
        sha256: SHA256,
      },
    });

    if (!etag) throw new Error("expected etag");
    const cached = await new HomebrewAdapter().handle(
      match,
      new Request("https://registry.test/api/formula/hootcli.json", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("raises a 404 RegistryError for an unknown formula", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.packages.findByName = async () => null;
    const match = {
      entry: { method: "GET", pattern: "/api/formula/:name", handlerId: "formula" },
      params: { name: "missing.json" },
      path: "/api/formula/missing.json",
    } satisfies RouteMatch;
    const handled = new HomebrewAdapter().handle(
      match,
      new Request("https://registry.test/api/formula/missing.json"),
      ctx,
    );
    // The runtime renders thrown RegistryErrors per errorResponseKind.
    await expect(handled).rejects.toBeInstanceOf(RegistryError);
    await expect(handled).rejects.toMatchObject({ status: 404 });
  });

  test("builds the formula index across packages and the names listing", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.packages.list = async () => [
      { id: pkg.id, orgId: pkg.orgId, repositoryId: pkg.repositoryId, name: "hootcli" },
    ];
    ctx.data.packages.listNames = async () => [{ name: "hootcli" }, { name: "aardvark" }];
    ctx.data.versions.listLive = async () => [versionRow("1.2.3", stableMeta)];

    const indexRes = await new HomebrewAdapter().handle(
      {
        entry: { method: "GET", pattern: "/api/formula.json", handlerId: "formulaIndex" },
        params: {},
        path: "/api/formula.json",
      },
      new Request("https://registry.test/api/formula.json"),
      ctx,
    );
    expect(indexRes.status).toBe(200);
    const formulas = (await indexRes.json()) as Array<{ name: string }>;
    expect(formulas).toHaveLength(1);
    expect(formulas[0]?.name).toBe("hootcli");

    const namesRes = await new HomebrewAdapter().handle(
      {
        entry: { method: "GET", pattern: "/api/formula_names.txt", handlerId: "formulaNames" },
        params: {},
        path: "/api/formula_names.txt",
      },
      new Request("https://registry.test/api/formula_names.txt"),
      ctx,
    );
    expect(namesRes.status).toBe(200);
    // Names are sorted deterministically.
    expect(await namesRes.text()).toBe("aardvark\nhootcli\n");
  });

  test("download resolves the bottle blob by the filename scope (no name/version reparse)", async () => {
    const ctx = withHomebrewRepo();
    // Use a hyphenated version: the old filename-splitting parser would have
    // resolved package "foo-2.0.0", 404ing. Resolving by the whole filename scope
    // is exact regardless of dashes/dots in name or version.
    const file = bottleFileName("foo", "2.0.0-rc.1", "ventura");
    let scopeLookedUp: string | undefined;
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("homebrew_bottle");
      scopeLookedUp = scope;
      return { digest: DIGEST, role, scope } as never;
    };
    let servedDigest: string | undefined;
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      servedDigest = digest;
      return new Response("bottle-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new HomebrewAdapter().handle(
      {
        entry: { method: "GET", pattern: "/bottles/:file", handlerId: "download" },
        params: { file },
        path: `/bottles/${file}`,
      },
      new Request(`https://registry.test/bottles/${file}`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(scopeLookedUp).toBe(file);
    expect(servedDigest).toBe(DIGEST);
    expect(res.headers.get("content-type")).toBe("application/gzip");
  });

  test("download raises a 404 when no bottle asset matches the filename", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.assets.findByScope = async () => null;
    const file = bottleFileName("hootcli", "1.2.3", "ventura");
    const handled = new HomebrewAdapter().handle(
      {
        entry: { method: "GET", pattern: "/bottles/:file", handlerId: "download" },
        params: { file },
        path: `/bottles/${file}`,
      },
      new Request(`https://registry.test/bottles/${file}`),
      ctx,
    );
    await expect(handled).rejects.toMatchObject({ status: 404 });
  });

  test("download rejects a malformed (non-bottle) filename with 404 before any lookup", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.assets.findByScope = async () => {
      throw new Error("should not look up a malformed filename");
    };
    const file = "../escape.tar.gz";
    const handled = new HomebrewAdapter().handle(
      {
        entry: { method: "GET", pattern: "/bottles/:file", handlerId: "download" },
        params: { file },
        path: `/bottles/${file}`,
      },
      new Request("https://registry.test/bottles/escape"),
      ctx,
    );
    await expect(handled).rejects.toMatchObject({ status: 404 });
  });

  test("resolveFormula picks the newest LIVE BOTTLED version, skipping empty-bottle ones", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.packages.findByName = async () => pkg;
    // listLive returns newest-first; the newest two versions have no bottles, so
    // the formula must fall through to the newest version that actually has one.
    ctx.data.versions.listLive = async (_row, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [
        versionRow("3.0.0", { bottles: {} }),
        versionRow("2.9.0", { desc: "no bottles here", bottles: {} }),
        versionRow("2.0.0", {
          bottles: { ventura: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 7 } },
        }),
        versionRow("1.0.0", {
          bottles: { ventura: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 1 } },
        }),
      ];
    };
    const match = {
      entry: { method: "GET", pattern: "/api/formula/:name", handlerId: "formula" },
      params: { name: "hootcli.json" },
      path: "/api/formula/hootcli.json",
    } satisfies RouteMatch;
    const res = await new HomebrewAdapter().handle(
      match,
      new Request("https://registry.test/api/formula/hootcli.json"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: { stable: string };
      bottle: { stable: { files: Record<string, unknown> } };
    };
    // 2.0.0 is the newest version carrying a bottle.
    expect(body.versions.stable).toBe("2.0.0");
    expect(Object.keys(body.bottle.stable.files)).toEqual(["ventura"]);
  });

  test("resolveFormula returns 404 when no live version carries a bottle", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("2.0.0", { bottles: {} }),
      versionRow("1.0.0", { bottles: {} }),
    ];
    const match = {
      entry: { method: "GET", pattern: "/api/formula/:name", handlerId: "formula" },
      params: { name: "hootcli.json" },
      path: "/api/formula/hootcli.json",
    } satisfies RouteMatch;
    const handled = new HomebrewAdapter().handle(
      match,
      new Request("https://registry.test/api/formula/hootcli.json"),
      ctx,
    );
    await expect(handled).rejects.toMatchObject({ status: 404 });
  });
});

function storedBlob(): RegistryStoredBlob {
  return {
    digest: DIGEST,
    size: 4,
    deduped: false,
    refCreated: true,
    blobRefId: "ref_1",
  };
}

function publishRequest(formula?: Record<string, unknown>): Request {
  const form = new FormData();
  form.set("bottle", new File([new TextEncoder().encode("gzip")], "bottle.tar.gz"));
  if (formula) form.set("formula", JSON.stringify(formula));
  return new Request("https://registry.test/api/formula/hootcli/1.2.3/arm64_sonoma", {
    method: "PUT",
    body: form,
  });
}

const publishMatch = {
  entry: { method: "PUT", pattern: "/api/formula/:name/:version/:tag", handlerId: "publish" },
  params: { name: "hootcli", version: "1.2.3", tag: "arm64_sonoma" },
  path: "/api/formula/hootcli/1.2.3/arm64_sonoma",
} satisfies RouteMatch;

describe("Homebrew publish", () => {
  test("rejects invalid :name/:version/:tag params before permissions and the handler", async () => {
    const ctx = withHomebrewRepo();
    const adapter = new HomebrewAdapter();
    const badParams = [
      { params: { name: "Bad/Name", version: "1.2.3", tag: "arm64_sonoma" }, code: "NAME_INVALID" },
      {
        params: { name: "hootcli", version: "bad version", tag: "arm64_sonoma" },
        code: "MANIFEST_INVALID",
      },
      { params: { name: "hootcli", version: "1.2.3", tag: "Bad-Tag" }, code: "NAME_INVALID" },
    ] as const;
    for (const { params, code } of badParams) {
      const match = { ...publishMatch, params } satisfies RouteMatch;
      // 400-before-403: garbage params short-circuit permission resolution too.
      expect(() => adapter.requiredPermission("PUT", match)).toThrow(
        expect.objectContaining({ status: 400, code }),
      );
      await expect(adapter.handle(match, publishRequest(), ctx)).rejects.toMatchObject({
        status: 400,
        code,
      });
    }
  });

  test("publishes a new bottle, persisting metadata and enqueuing a scan", async () => {
    const ctx = withHomebrewRepo();
    let createdMetadata: Record<string, unknown> | undefined;
    let createdSize: number | undefined;
    let scanned: { digest: string } | undefined;
    let asset: { scope?: string } | undefined;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      expect(input.kind).toBe("homebrew_bottle");
      expect(input.scope).toBe(bottleScope("hootcli", "1.2.3", "arm64_sonoma"));
      return storedBlob();
    };
    ctx.data.packages.findOrCreate = async ({ name }) => {
      expect(name).toBe("hootcli");
      return pkg;
    };
    ctx.data.versions.create = async (input) => {
      createdMetadata = input.metadata;
      createdSize = input.sizeBytes;
      return "ver_new";
    };
    ctx.data.assets.upsert = async (input) => {
      asset = input;
      return {} as never;
    };
    ctx.enqueueScan = async (input) => {
      scanned = input;
    };

    const res = await new HomebrewAdapter().handle(
      publishMatch,
      publishRequest({ desc: "A demo CLI", homepage: "https://example.test", license: "MIT" }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      name: "hootcli",
      version: "1.2.3",
      tag: "arm64_sonoma",
    });
    expect(createdMetadata).toEqual({
      desc: "A demo CLI",
      homepage: "https://example.test",
      license: "MIT",
      bottles: { arm64_sonoma: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 4 } },
    });
    // The version size is the sum of its bottle blob sizes (one 4-byte bottle).
    expect(createdSize).toBe(4);
    expect(asset?.scope).toBe(bottleScope("hootcli", "1.2.3", "arm64_sonoma"));
    expect(scanned?.digest).toBe(DIGEST);
  });

  test("adds a second tag to an existing version via patch and grows the version size", async () => {
    const ctx = withHomebrewRepo();
    let patchedMeta: Record<string, unknown> | undefined;
    let patchedSize: number | undefined;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => storedBlob();
    ctx.data.packages.findOrCreate = async () => pkg;
    // Version already exists -> create() returns null, lifecycle falls back to patch().
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const update = patch({
        id: "ver_1",
        deletedAt: null,
        metadata: {
          desc: "A demo CLI",
          bottles: { x86_64_linux: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 5 } },
        },
      });
      if ("update" in update && update.update) {
        patchedMeta = update.update.metadata;
        patchedSize = update.update.sizeBytes;
      }
      return update.result;
    };
    ctx.data.assets.upsert = async () => ({}) as never;
    ctx.enqueueScan = async () => {};

    const res = await new HomebrewAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(201);
    expect(patchedMeta?.bottles).toEqual({
      x86_64_linux: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 5 },
      arm64_sonoma: { blobDigest: DIGEST, sha256: SHA256, sizeBytes: 4 },
    });
    // Size is recomputed from the merged bottles: existing 5 + new 4-byte bottle.
    expect(patchedSize).toBe(9);
  });

  test("rejects a duplicate bottle (same name/version/tag) with 409 and releases the ref", async () => {
    const ctx = withHomebrewRepo();
    let released = false;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => storedBlob();
    ctx.data.content.releaseBlobRef = async () => {
      released = true;
    };
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const update = patch({
        id: "ver_1",
        deletedAt: null,
        metadata: { bottles: { arm64_sonoma: { blobDigest: DIGEST, sha256: SHA256 } } },
      });
      return update.result;
    };

    const res = await new HomebrewAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(409);
    expect(released).toBe(true);
  });

  test("rejects re-publishing an already-stored bottle asset with 409", async () => {
    const ctx = withHomebrewRepo();
    ctx.data.assets.findByScope = async (input) => {
      expect(input.includeDeleted).toBe(true);
      return { scope: input.scope } as never;
    };
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new Error("should not store when the bottle already exists");
    };
    const res = await new HomebrewAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(409);
  });
});
