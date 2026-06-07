import { afterEach, describe, expect, test } from "bun:test";
import type { RegistryPackageRow } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handleCondaProxyIngest } from "./conda-proxy";

const PACKAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const PACKAGE_SHA256 = new Bun.CryptoHasher("sha256").update(PACKAGE_BYTES).digest("hex");
const PACKAGE_MD5 = new Bun.CryptoHasher("md5").update(PACKAGE_BYTES).digest("hex");

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockUpstream(repodata: unknown, packageBytes: Uint8Array | null) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/repodata.json")) {
      return new Response(JSON.stringify(repodata), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (packageBytes) {
      return new Response(packageBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("Conda proxy ingest", () => {
  test("mirrors a package referenced by the upstream repodata", async () => {
    const ctx = createTestRegistryContext();
    const upserts: Array<{ version: string; metadata: Record<string, unknown> }> = [];
    let scanned = false;
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.versions.upsertWithBlobRef = async (input) => {
      upserts.push({ version: input.version, metadata: input.metadata });
      return {
        stored: {
          digest: `sha256:${PACKAGE_SHA256}`,
          size: input.sizeBytes,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        },
        versionId: "ver_1",
      };
    };
    ctx.enqueueScan = async () => {
      scanned = true;
    };

    mockUpstream(
      {
        info: { subdir: "linux-64" },
        packages: {},
        "packages.conda": {
          "numpy-1.21.0-py39_0.conda": {
            name: "numpy",
            version: "1.21.0",
            build: "py39_0",
            build_number: 0,
            depends: ["python >=3.9"],
            sha256: PACKAGE_SHA256,
            md5: PACKAGE_MD5,
            size: PACKAGE_BYTES.length,
          },
        },
      },
      PACKAGE_BYTES,
    );

    const ok = await handleCondaProxyIngest(
      "linux-64",
      "https://conda.anaconda.org/conda-forge",
      ctx,
    );
    expect(ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.metadata).toMatchObject({
      subdir: "linux-64",
      filename: "numpy-1.21.0-py39_0.conda",
      packageKind: "conda",
      sha256: PACKAGE_SHA256,
    });
    expect(scanned).toBe(true);
  });

  test("rejects a package whose bytes do not match the advertised sha256", async () => {
    const ctx = createTestRegistryContext();
    let upserted = false;
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.versions.upsertWithBlobRef = async () => {
      upserted = true;
      return {
        stored: {
          digest: `sha256:${PACKAGE_SHA256}`,
          size: 0,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        },
        versionId: "ver_1",
      };
    };

    mockUpstream(
      {
        info: { subdir: "linux-64" },
        packages: {},
        "packages.conda": {
          "numpy-1.21.0-py39_0.conda": {
            name: "numpy",
            version: "1.21.0",
            build: "py39_0",
            sha256: "f".repeat(64),
            size: PACKAGE_BYTES.length,
          },
        },
      },
      PACKAGE_BYTES,
    );

    const ok = await handleCondaProxyIngest(
      "linux-64",
      "https://conda.anaconda.org/conda-forge",
      ctx,
    );
    expect(ok).toBe(false);
    expect(upserted).toBe(false);
  });

  test("verifies legacy md5-only records and rejects an md5 mismatch", async () => {
    const ctx = createTestRegistryContext();
    let upserted = false;
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.versions.upsertWithBlobRef = async () => {
      upserted = true;
      return {
        stored: {
          digest: `sha256:${PACKAGE_SHA256}`,
          size: 0,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        },
        versionId: "ver_1",
      };
    };

    // A legacy `.tar.bz2` record with only md5, and the md5 does not match.
    mockUpstream(
      {
        info: { subdir: "linux-64" },
        packages: {
          "numpy-1.21.0-py39_0.tar.bz2": {
            name: "numpy",
            version: "1.21.0",
            build: "py39_0",
            md5: "0".repeat(32),
            size: PACKAGE_BYTES.length,
          },
        },
        "packages.conda": {},
      },
      PACKAGE_BYTES,
    );

    const ok = await handleCondaProxyIngest(
      "linux-64",
      "https://conda.anaconda.org/conda-forge",
      ctx,
    );
    expect(ok).toBe(false);
    expect(upserted).toBe(false);
  });

  test("refuses to mirror a package the index declares no checksum for", async () => {
    const ctx = createTestRegistryContext();
    let upserted = false;
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.versions.upsertWithBlobRef = async () => {
      upserted = true;
      return {
        stored: {
          digest: `sha256:${PACKAGE_SHA256}`,
          size: 0,
          deduped: false,
          refCreated: true,
          blobRefId: "ref_1",
        },
        versionId: "ver_1",
      };
    };

    mockUpstream(
      {
        info: { subdir: "linux-64" },
        packages: {},
        "packages.conda": {
          "numpy-1.21.0-py39_0.conda": {
            name: "numpy",
            version: "1.21.0",
            build: "py39_0",
            size: PACKAGE_BYTES.length,
          },
        },
      },
      PACKAGE_BYTES,
    );

    const ok = await handleCondaProxyIngest(
      "linux-64",
      "https://conda.anaconda.org/conda-forge",
      ctx,
    );
    expect(ok).toBe(false);
    expect(upserted).toBe(false);
  });

  test("returns false for an invalid subdir or unparseable upstream", async () => {
    const ctx = createTestRegistryContext();
    expect(await handleCondaProxyIngest("bad/sub", "https://conda.anaconda.org/x", ctx)).toBe(
      false,
    );

    mockUpstream({ not: "repodata" }, null);
    expect(await handleCondaProxyIngest("linux-64", "https://conda.anaconda.org/x", ctx)).toBe(
      false,
    );
  });
});
