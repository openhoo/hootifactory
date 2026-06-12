import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  listProviderVersions,
  providerDownloadInfo,
  providerPackageName,
  providerReferencedDigests,
  publishProviderVersion,
  serveProviderShasums,
  serveProviderShasumsSignature,
  serveProviderZip,
} from "./terraform-providers";
import { parseTerraformProviderVersionMeta } from "./terraform-validation";
import { buildMultipartBody, jsonField } from "./terraform-validation.test";

const ZIP_DIGEST = `sha256:${"1".repeat(64)}`;
const SHASUMS_DIGEST = `sha256:${"2".repeat(64)}`;
const SIG_DIGEST = `sha256:${"3".repeat(64)}`;
// Publish verifies the manifest shasum against the stored zip's content-addressed
// digest, so the declared shasum MUST equal the hex of ZIP_DIGEST.
const SHASUM_HEX = "1".repeat(64);

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

function providerMeta(version: string) {
  return {
    kind: "provider",
    namespace: "hashicorp",
    type: "random",
    version,
    protocols: ["5.0"],
    platforms: [
      {
        os: "linux",
        arch: "amd64",
        filename: `terraform-provider-random_${version}_linux_amd64.zip`,
        blobDigest: ZIP_DIGEST,
        shasum: SHASUM_HEX,
      },
    ],
    shasumsDigest: SHASUMS_DIGEST,
    shasumsFilename: `terraform-provider-random_${version}_SHA256SUMS`,
    shasumsSignatureDigest: SIG_DIGEST,
    shasumsSignatureFilename: `terraform-provider-random_${version}_SHA256SUMS.sig`,
    signingKeys: [{ keyId: "51852D87348FFC4C", asciiArmor: "-----BEGIN PGP PUBLIC KEY-----" }],
  };
}

function versionRow(metadata: Record<string, unknown>, version: string): RegistryPackageVersionRow {
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

function terraformContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "terraform", mountPath: "terraform/private" };
  return ctx;
}

describe("Terraform provider protocol", () => {
  test("GET versions lists versions with protocols + platforms", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(providerPackageName("hashicorp", "random"));
      return pkgRow(name);
    };
    ctx.data.versions.listLive = async () => [versionRow(providerMeta("2.0.0"), "2.0.0")];

    const res = await listProviderVersions(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random/versions"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      versions: [
        {
          version: "2.0.0",
          protocols: ["5.0"],
          platforms: [{ os: "linux", arch: "amd64" }],
        },
      ],
    });
  });

  test("download returns the descriptor with hosted urls + shasum + signing keys", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () => versionRow(providerMeta("2.0.0"), "2.0.0");

    const res = await providerDownloadInfo(
      "hashicorp",
      "random",
      "2.0.0",
      "linux",
      "amd64",
      new Request("https://registry.test/v1/providers/hashicorp/random/2.0.0/download/linux/amd64"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      protocols: ["5.0"],
      os: "linux",
      arch: "amd64",
      filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
      download_url:
        "https://registry.example.test/terraform/private/v1/providers/hashicorp/random/2.0.0/download/linux/amd64/zip",
      shasums_url:
        "https://registry.example.test/terraform/private/v1/providers/hashicorp/random/2.0.0/shasums",
      shasum: SHASUM_HEX,
      shasums_signature_url:
        "https://registry.example.test/terraform/private/v1/providers/hashicorp/random/2.0.0/shasums.sig",
      signing_keys: {
        gpg_public_keys: [
          { key_id: "51852D87348FFC4C", ascii_armor: "-----BEGIN PGP PUBLIC KEY-----" },
        ],
      },
    });
  });

  test("download 404s for an unknown platform", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () => versionRow(providerMeta("2.0.0"), "2.0.0");
    await expect(
      providerDownloadInfo(
        "hashicorp",
        "random",
        "2.0.0",
        "windows",
        "arm64",
        new Request(
          "https://registry.test/v1/providers/hashicorp/random/2.0.0/download/windows/arm64",
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("zip serves the platform's stored blob", async () => {
    const ctx = terraformContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () => versionRow(providerMeta("2.0.0"), "2.0.0");
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("zip-bytes", { headers: { "content-type": contentType } });
    };

    const res = await serveProviderZip(
      "hashicorp",
      "random",
      "2.0.0",
      "linux",
      "amd64",
      new Request("https://registry.test/.../zip"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(ZIP_DIGEST);
    expect(res.headers.get("content-type")).toContain("application/zip");
  });

  test("shasums and shasums.sig serve their stored blobs", async () => {
    const ctx = terraformContext();
    const served: string[] = [];
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () => versionRow(providerMeta("2.0.0"), "2.0.0");
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.push(digest);
      return new Response("bytes", { headers: { "content-type": contentType } });
    };

    const shasums = await serveProviderShasums(
      "hashicorp",
      "random",
      "2.0.0",
      new Request("https://registry.test/.../shasums"),
      ctx,
    );
    const sig = await serveProviderShasumsSignature(
      "hashicorp",
      "random",
      "2.0.0",
      new Request("https://registry.test/.../shasums.sig"),
      ctx,
    );
    expect(shasums.status).toBe(200);
    expect(sig.status).toBe(200);
    expect(served).toEqual([SHASUMS_DIGEST, SIG_DIGEST]);
  });

  test("PUT publishes a multi-blob provider version and stores all coordinates", async () => {
    const ctx = terraformContext();
    const stored: { scope: string; kind: string }[] = [];
    const committed: {
      metadata?: Record<string, unknown>;
      scan?: unknown;
      extraScans?: Array<{ digest: string; name?: string; version?: string; mediaType?: string }>;
    } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    const digestByScope = new Map<string, string>([
      ["hashicorp/random@2.0.0/linux_amd64", ZIP_DIGEST],
      ["hashicorp/random@2.0.0/SHASUMS", SHASUMS_DIGEST],
      ["hashicorp/random@2.0.0/SHASUMS.sig", SIG_DIGEST],
    ]);
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      stored.push({ scope: input.scope, kind: input.kind });
      return {
        digest: digestByScope.get(input.scope) ?? `sha256:${"0".repeat(64)}`,
        size: input.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: `ref_${stored.length}`,
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      committed.extraScans = input.extraScans;
      return { versionId: "ver_1" };
    };

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [
          {
            os: "linux",
            arch: "amd64",
            filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
            shasum: SHASUM_HEX,
          },
        ],
        shasums: "terraform-provider-random_2.0.0_SHA256SUMS",
        shasums_signature: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        signing_keys: [{ keyId: "51852D87348FFC4C", asciiArmor: "-----BEGIN PGP PUBLIC KEY-----" }],
      }),
      {
        name: "terraform-provider-random_2.0.0_linux_amd64.zip",
        filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
        data: new Uint8Array([1, 2, 3, 4]),
      },
      {
        name: "terraform-provider-random_2.0.0_SHA256SUMS",
        filename: "terraform-provider-random_2.0.0_SHA256SUMS",
        data: new TextEncoder().encode(`${SHASUM_HEX}  x.zip\n`),
      },
      {
        name: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        filename: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        data: new Uint8Array([9, 9]),
      },
    ]);

    const res = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      namespace: "hashicorp",
      type: "random",
      version: "2.0.0",
    });
    // Stored the platform zip, the SHASUMS, and the signature.
    expect(stored.map((s) => s.scope)).toEqual([
      "hashicorp/random@2.0.0/linux_amd64",
      "hashicorp/random@2.0.0/SHASUMS",
      "hashicorp/random@2.0.0/SHASUMS.sig",
    ]);
    // The committed (SHASUMS) blob is scanned as text; each platform zip is
    // enqueued for scanning separately as application/zip.
    expect(committed.scan).toEqual({
      name: "provider/hashicorp/random",
      version: "2.0.0",
      mediaType: "text/plain; charset=utf-8",
    });
    expect(committed.extraScans).toEqual([
      {
        digest: ZIP_DIGEST,
        name: "provider/hashicorp/random",
        version: "2.0.0",
        mediaType: "application/zip",
      },
    ]);
    const meta = parseTerraformProviderVersionMeta(committed.metadata);
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({
      kind: "provider",
      protocols: ["5.0"],
      shasumsDigest: SHASUMS_DIGEST,
      shasumsSignatureDigest: SIG_DIGEST,
    });
    expect(meta?.platforms[0]).toMatchObject({
      os: "linux",
      arch: "amd64",
      blobDigest: ZIP_DIGEST,
      shasum: SHASUM_HEX,
    });
  });

  test("round-trip: the metadata publish writes is consumable by the read endpoints", async () => {
    const ctx = terraformContext();
    let writtenMeta: Record<string, unknown> | undefined;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    const digestByScope = new Map<string, string>([
      ["hashicorp/random@2.0.0/linux_amd64", ZIP_DIGEST],
      ["hashicorp/random@2.0.0/SHASUMS", SHASUMS_DIGEST],
      ["hashicorp/random@2.0.0/SHASUMS.sig", SIG_DIGEST],
    ]);
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => ({
      digest: digestByScope.get(input.scope) ?? `sha256:${"0".repeat(64)}`,
      size: input.data.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      writtenMeta = input.metadata;
      return { versionId: "ver_1" };
    };

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0", "6.0"],
        platforms: [
          {
            os: "linux",
            arch: "amd64",
            filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
            shasum: SHASUM_HEX,
          },
        ],
        shasums: "terraform-provider-random_2.0.0_SHA256SUMS",
        shasums_signature: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        signing_keys: [{ keyId: "51852D87348FFC4C", asciiArmor: "-----BEGIN PGP PUBLIC KEY-----" }],
      }),
      {
        name: "terraform-provider-random_2.0.0_linux_amd64.zip",
        filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
        data: new Uint8Array([1, 2, 3, 4]),
      },
      {
        name: "terraform-provider-random_2.0.0_SHA256SUMS",
        filename: "terraform-provider-random_2.0.0_SHA256SUMS",
        data: new TextEncoder().encode(`${SHASUM_HEX}  x.zip\n`),
      },
      {
        name: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        filename: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        data: new Uint8Array([9, 9]),
      },
    ]);
    const pub = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(pub.status).toBe(201);
    expect(writtenMeta).toBeDefined();

    // Feed the EXACT metadata publish wrote back through the read endpoints.
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () =>
      versionRow(writtenMeta as Record<string, unknown>, "2.0.0");
    ctx.data.versions.listLive = async () => [
      versionRow(writtenMeta as Record<string, unknown>, "2.0.0"),
    ];

    const versions = await listProviderVersions(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random/versions"),
      ctx,
    );
    expect(await versions.json()).toEqual({
      versions: [
        {
          version: "2.0.0",
          protocols: ["5.0", "6.0"],
          platforms: [{ os: "linux", arch: "amd64" }],
        },
      ],
    });

    const download = await providerDownloadInfo(
      "hashicorp",
      "random",
      "2.0.0",
      "linux",
      "amd64",
      new Request("https://registry.test/v1/providers/hashicorp/random/2.0.0/download/linux/amd64"),
      ctx,
    );
    expect(await download.json()).toMatchObject({
      protocols: ["5.0", "6.0"],
      filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
      shasum: SHASUM_HEX,
      shasums_signature_url:
        "https://registry.example.test/terraform/private/v1/providers/hashicorp/random/2.0.0/shasums.sig",
    });
  });

  test("PUT returns 409 when the version already exists", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [{ os: "linux", arch: "amd64", filename: "p.zip", shasum: SHASUM_HEX }],
        shasums: "SHASUMS",
      }),
      { name: "p.zip", filename: "p.zip", data: new Uint8Array([1]) },
      { name: "SHASUMS", filename: "SHASUMS", data: new Uint8Array([2]) },
    ]);
    const res = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
  });

  test("PUT 400s when a declared platform zip part is missing", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [{ os: "linux", arch: "amd64", filename: "missing.zip", shasum: SHASUM_HEX }],
        shasums: "SHASUMS",
      }),
      { name: "SHASUMS", filename: "SHASUMS", data: new Uint8Array([2]) },
    ]);
    const res = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("providerReferencedDigests surfaces every CAS digest the version owns", () => {
    const meta = parseTerraformProviderVersionMeta(providerMeta("2.0.0"));
    expect(meta).not.toBeNull();
    if (!meta) throw new Error("expected meta");
    expect(providerReferencedDigests(meta).sort()).toEqual(
      [ZIP_DIGEST, SHASUMS_DIGEST, SIG_DIGEST].sort(),
    );
  });

  test("providerReferencedDigests omits the signature when none was published", () => {
    const meta = parseTerraformProviderVersionMeta({
      kind: "provider",
      namespace: "hashicorp",
      type: "random",
      version: "2.0.0",
      protocols: ["5.0"],
      platforms: [
        {
          os: "linux",
          arch: "amd64",
          filename: "p.zip",
          blobDigest: ZIP_DIGEST,
          shasum: SHASUM_HEX,
        },
      ],
      shasumsDigest: SHASUMS_DIGEST,
      shasumsFilename: "SHASUMS",
    });
    expect(meta).not.toBeNull();
    if (!meta) throw new Error("expected meta");
    expect(providerReferencedDigests(meta).sort()).toEqual([ZIP_DIGEST, SHASUMS_DIGEST].sort());
  });

  test("PUT 400s when a platform zip's content does not match the manifest shasum", async () => {
    const ctx = terraformContext();
    const released: string[] = [];
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.releaseBlobRef = async ({ scope }) => {
      released.push(scope);
    };
    // The stored zip hashes to ZIP_DIGEST, but the manifest declares a different shasum.
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => ({
      digest: ZIP_DIGEST,
      size: input.data.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [{ os: "linux", arch: "amd64", filename: "p.zip", shasum: "c".repeat(64) }],
        shasums: "SHASUMS",
      }),
      { name: "p.zip", filename: "p.zip", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "SHASUMS", filename: "SHASUMS", data: new Uint8Array([2]) },
    ]);
    const res = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("shasum mismatch") });
    // The already-stored platform-zip ref is released so the rejected publish leaks nothing.
    expect(released).toEqual(["hashicorp/random@2.0.0/linux_amd64"]);
  });

  test("PUT releases orphaned platform/signature refs on a commit conflict", async () => {
    const ctx = terraformContext();
    const released: string[] = [];
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    // Pass the early exists() guard, then lose the authoritative commit race.
    ctx.data.versions.exists = async () => false;
    ctx.data.content.releaseBlobRef = async ({ scope }) => {
      released.push(scope);
    };
    const digestByScope = new Map<string, string>([
      ["hashicorp/random@2.0.0/linux_amd64", ZIP_DIGEST],
      ["hashicorp/random@2.0.0/SHASUMS", SHASUMS_DIGEST],
      ["hashicorp/random@2.0.0/SHASUMS.sig", SIG_DIGEST],
    ]);
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => ({
      digest: digestByScope.get(input.scope) ?? `sha256:${"0".repeat(64)}`,
      size: input.data.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async () => ({ conflict: true }) as never;

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [
          {
            os: "linux",
            arch: "amd64",
            filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
            shasum: SHASUM_HEX,
          },
        ],
        shasums: "terraform-provider-random_2.0.0_SHA256SUMS",
        shasums_signature: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
      }),
      {
        name: "terraform-provider-random_2.0.0_linux_amd64.zip",
        filename: "terraform-provider-random_2.0.0_linux_amd64.zip",
        data: new Uint8Array([1, 2, 3, 4]),
      },
      {
        name: "terraform-provider-random_2.0.0_SHA256SUMS",
        filename: "terraform-provider-random_2.0.0_SHA256SUMS",
        data: new TextEncoder().encode(`${SHASUM_HEX}  x.zip\n`),
      },
      {
        name: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        filename: "terraform-provider-random_2.0.0_SHA256SUMS.sig",
        data: new Uint8Array([9, 9]),
      },
    ]);
    const res = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    // The platform-zip and signature refs (but not SHASUMS, released by commitOrReleaseBlob)
    // are released by the adapter.
    expect(released).toEqual([
      "hashicorp/random@2.0.0/linux_amd64",
      "hashicorp/random@2.0.0/SHASUMS.sig",
    ]);
  });

  test("PUT 400s when a platform filename contains a path separator", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [{ os: "linux", arch: "amd64", filename: "../evil.zip", shasum: SHASUM_HEX }],
        shasums: "SHASUMS",
      }),
      { name: "../evil.zip", filename: "../evil.zip", data: new Uint8Array([1]) },
      { name: "SHASUMS", filename: "SHASUMS", data: new Uint8Array([2]) },
    ]);
    const res = await publishProviderVersion(
      "hashicorp",
      "random",
      new Request("https://registry.test/v1/providers/hashicorp/random", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("download omits signature url + signing keys when none were published", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () =>
      versionRow(
        {
          kind: "provider",
          namespace: "hashicorp",
          type: "random",
          version: "2.0.0",
          protocols: ["5.0"],
          platforms: [
            {
              os: "linux",
              arch: "amd64",
              filename: "p.zip",
              blobDigest: ZIP_DIGEST,
              shasum: SHASUM_HEX,
            },
          ],
          shasumsDigest: SHASUMS_DIGEST,
          shasumsFilename: "SHASUMS",
        },
        "2.0.0",
      );

    const res = await providerDownloadInfo(
      "hashicorp",
      "random",
      "2.0.0",
      "linux",
      "amd64",
      new Request("https://registry.test/v1/providers/hashicorp/random/2.0.0/download/linux/amd64"),
      ctx,
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.shasums_signature_url).toBeUndefined();
    expect(doc.signing_keys).toBeUndefined();
    expect(doc.shasum).toBe(SHASUM_HEX);
  });

  test("shasums.sig 404s when no signature was published", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () =>
      versionRow(
        {
          kind: "provider",
          namespace: "hashicorp",
          type: "random",
          version: "2.0.0",
          protocols: ["5.0"],
          platforms: [
            {
              os: "linux",
              arch: "amd64",
              filename: "p.zip",
              blobDigest: ZIP_DIGEST,
              shasum: SHASUM_HEX,
            },
          ],
          shasumsDigest: SHASUMS_DIGEST,
          shasumsFilename: "SHASUMS",
        },
        "2.0.0",
      );

    await expect(
      serveProviderShasumsSignature(
        "hashicorp",
        "random",
        "2.0.0",
        new Request("https://registry.test/v1/providers/hashicorp/random/2.0.0/shasums.sig"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
