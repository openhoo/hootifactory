import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { CranAdapter } from "./cran-adapter";
import { buildCranTarball } from "./cran-tarball.test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

const DESCRIPTION =
  "Package: demo\nVersion: 1.2.3\nTitle: A Demo Package\n" +
  "Depends: R (>= 3.5.0), Rcpp\nImports: jsonlite\nLicense: MIT\n";

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: "1.2.3",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(
  metadata: Record<string, unknown>,
  version = "1.2.3",
): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_demo",
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

const storedMeta = {
  name: "demo",
  version: "1.2.3",
  controlFields: [
    ["Title", "A Demo Package"],
    ["Depends", "R (>= 3.5.0), Rcpp"],
    ["Imports", "jsonlite"],
    ["License", "MIT"],
  ] as Array<[string, string]>,
  deps: ["R", "Rcpp", "jsonlite"],
  blobDigest: DIGEST,
  sha256: HEX,
  md5: "c".repeat(32),
  sizeBytes: 100,
};

function cranContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "cran", mountPath: "cran/private" };
  return ctx;
}

function match(handlerId: string, pattern: string, params: Record<string, string>): RouteMatch {
  return { entry: { method: "GET", pattern, handlerId }, params, path: pattern };
}

describe("CranAdapter", () => {
  test("declares index, download, publish, and binary routes (literals before :filename)", () => {
    expect(new CranAdapter().routes()).toEqual([
      { method: "GET", pattern: "/src/contrib/PACKAGES", handlerId: "packages" },
      { method: "GET", pattern: "/src/contrib/PACKAGES.gz", handlerId: "packagesGz" },
      { method: "GET", pattern: "/src/contrib/:filename", handlerId: "download" },
      { method: "PUT", pattern: "/src/contrib/:filename", handlerId: "publish" },
      { method: "GET", pattern: "/bin/:path+", handlerId: "binary" },
    ]);
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new CranAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the artifact ref derived from the filename", () => {
    const adapter = new CranAdapter();
    const m = {
      entry: { method: "GET", pattern: "/src/contrib/:filename", handlerId: "download" },
      params: { filename: "demo_1.2.3.tar.gz" },
      path: "/src/contrib/demo_1.2.3.tar.gz",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "demo",
        artifactRef: "src/contrib/demo_1.2.3.tar.gz",
      },
    });
  });

  test("declares proxyable + virtualizable capabilities", () => {
    expect(new CranAdapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
  });

  test("GET /src/contrib/PACKAGES regenerates a control-stanza index, cacheable", async () => {
    const ctx = cranContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [versionRow(storedMeta)];
    };

    const res = await new CranAdapter().handle(
      match("packages", "/src/contrib/PACKAGES", {}),
      new Request("https://r.test/cran/private/src/contrib/PACKAGES"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toBe(
      "Package: demo\nVersion: 1.2.3\nTitle: A Demo Package\n" +
        "Depends: R (>= 3.5.0), Rcpp\nImports: jsonlite\nLicense: MIT\n" +
        `MD5sum: ${"c".repeat(32)}\n`,
    );
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");

    const cached = await new CranAdapter().handle(
      match("packages", "/src/contrib/PACKAGES", {}),
      new Request("https://r.test/cran/private/src/contrib/PACKAGES", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /src/contrib/PACKAGES.gz serves a gzip variant with an ETag", async () => {
    const ctx = cranContext();
    ctx.data.packages.listNames = async () => [{ name: "demo" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(storedMeta)];

    const res = await new CranAdapter().handle(
      match("packagesGz", "/src/contrib/PACKAGES.gz", {}),
      new Request("https://r.test/cran/private/src/contrib/PACKAGES.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const gunzipped = Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(gunzipped)).toContain("Package: demo");
  });

  test("download resolves the stored blob digest for the tarball filename", async () => {
    const ctx = cranContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkgRow("demo");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("tarball-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new CranAdapter().handle(
      match("download", "/src/contrib/:filename", { filename: "demo_1.2.3.tar.gz" }),
      new Request("https://r.test/cran/private/src/contrib/demo_1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(await res.text()).toBe("tarball-bytes");
  });

  test("download 404s for an unparseable filename", async () => {
    const ctx = cranContext();
    await expect(
      new CranAdapter().handle(
        match("download", "/src/contrib/:filename", { filename: "demo-1.0.zip" }),
        new Request("https://r.test/cran/private/src/contrib/demo-1.0.zip"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("download 404s when the version is missing or not live", async () => {
    const ctx = cranContext();
    ctx.data.packages.findByName = async () => pkgRow("demo");
    ctx.data.versions.findLive = async () => null;
    await expect(
      new CranAdapter().handle(
        match("download", "/src/contrib/:filename", { filename: "demo_9.9.9.tar.gz" }),
        new Request("https://r.test/cran/private/src/contrib/demo_9.9.9.tar.gz"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("GET /bin/... always 404s (no binary hosting)", async () => {
    const ctx = cranContext();
    await expect(
      new CranAdapter().handle(
        {
          entry: { method: "GET", pattern: "/bin/:path+", handlerId: "binary" },
          params: { path: "windows/contrib/4.3/demo_1.0.zip" },
          path: "/bin/windows/contrib/4.3/demo_1.0.zip",
        },
        new Request("https://r.test/cran/private/bin/windows/contrib/4.3/demo_1.0.zip"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("scan.referencedDigests + dependencyGraph surface stored metadata", () => {
    const scan = new CranAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ version: "1.0.0" })).toEqual([]);
    expect(scan?.dependencyGraph?.({ metadata: { ...storedMeta } })).toEqual({
      deps: { R: "", Rcpp: "", jsonlite: "" },
      osvEcosystem: "CRAN",
      purlType: "cran",
    });
  });

  test("PUT publishes a source tarball and stores derived metadata", async () => {
    const ctx = cranContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    const tarball = buildCranTarball("demo", DESCRIPTION);
    const expectedMd5 = new Bun.CryptoHasher("md5").update(tarball).digest("hex");

    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: tarball.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const res = await new CranAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/src/contrib/:filename", handlerId: "publish" },
        params: { filename: "demo_1.2.3.tar.gz" },
        path: "/src/contrib/demo_1.2.3.tar.gz",
      },
      new Request("https://r.test/cran/private/src/contrib/demo_1.2.3.tar.gz", {
        method: "PUT",
        body: tarball,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, package: "demo", version: "1.2.3" });
    expect(committed.scan).toEqual({
      name: "demo",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      name: "demo",
      version: "1.2.3",
      blobDigest: DIGEST,
      sha256: HEX,
      md5: expectedMd5,
      deps: ["R", "Rcpp", "jsonlite"],
      controlFields: [
        ["Title", "A Demo Package"],
        ["Depends", "R (>= 3.5.0), Rcpp"],
        ["Imports", "jsonlite"],
        ["License", "MIT"],
      ],
    });
  });

  test("PUT returns 409 when the version already exists", async () => {
    const ctx = cranContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const res = await new CranAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/src/contrib/:filename", handlerId: "publish" },
        params: { filename: "demo_1.2.3.tar.gz" },
        path: "/src/contrib/demo_1.2.3.tar.gz",
      },
      new Request("https://r.test/cran/private/src/contrib/demo_1.2.3.tar.gz", {
        method: "PUT",
        body: buildCranTarball("demo", DESCRIPTION),
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("PUT 400s for a filename that is not <pkg>_<version>.tar.gz", async () => {
    const ctx = cranContext();
    await expect(
      new CranAdapter().handle(
        {
          entry: { method: "PUT", pattern: "/src/contrib/:filename", handlerId: "publish" },
          params: { filename: "demo-1.0.zip" },
          path: "/src/contrib/demo-1.0.zip",
        },
        new Request("https://r.test/cran/private/src/contrib/demo-1.0.zip", {
          method: "PUT",
          body: new Uint8Array([1, 2, 3]),
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("PUT 422s when the DESCRIPTION Package/Version disagree with the filename", async () => {
    const ctx = cranContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;

    const res = await new CranAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/src/contrib/:filename", handlerId: "publish" },
        params: { filename: "demo_9.9.9.tar.gz" },
        path: "/src/contrib/demo_9.9.9.tar.gz",
      },
      new Request("https://r.test/cran/private/src/contrib/demo_9.9.9.tar.gz", {
        method: "PUT",
        body: buildCranTarball("demo", DESCRIPTION),
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "filename does not match the DESCRIPTION Package/Version",
    });
  });

  test("PUT 422s when the body is not a gzipped source package", async () => {
    const ctx = cranContext();
    const res = await new CranAdapter().handle(
      {
        entry: { method: "PUT", pattern: "/src/contrib/:filename", handlerId: "publish" },
        params: { filename: "demo_1.2.3.tar.gz" },
        path: "/src/contrib/demo_1.2.3.tar.gz",
      },
      new Request("https://r.test/cran/private/src/contrib/demo_1.2.3.tar.gz", {
        method: "PUT",
        body: new TextEncoder().encode("not a gzip"),
      }),
      ctx,
    );
    expect(res.status).toBe(422);
  });
});
