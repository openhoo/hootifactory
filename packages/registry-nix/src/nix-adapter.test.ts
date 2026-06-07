import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { NixAdapter } from "./nix-adapter";
import { buildNarInfoMeta, parseNarInfoText } from "./nix-validation";

// 32-char Nix base32 store hash and a 52-char base32 NAR file hash.
// Nix base32 alphabet: 0123456789abcdfghijklmnpqrsvwxyz (no e o u t).
const STORE_HASH = "1q8w9z0r1d2y3a4i5k6p7s8s9d0f1g2h"; // 32 base32 chars
const FILE_HASH = "0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk"; // 52 base32 chars
const NAR_HASH = "vwxyz0123456789abcdfghijklmnpqrsvwxyz0123456789abcdf"; // 52 base32 chars
const NAR_DIGEST = `sha256:${"a".repeat(64)}`;

const NARINFO_BODY = [
  `StorePath: /nix/store/${STORE_HASH}-hello-2.12.1`,
  `URL: nar/${FILE_HASH}.nar.xz`,
  "Compression: xz",
  `FileHash: sha256:${FILE_HASH}`,
  "FileSize: 41232",
  `NarHash: sha256:${NAR_HASH}`,
  "NarSize: 226552",
  `References: ${STORE_HASH}-hello-2.12.1 abc123def456ghj789klmn012pqrs345t-glibc-2.39`,
  "Deriver: 0000000000000000000000000000000a-hello-2.12.1.drv",
  "Sig: cache.example.org-1:AbCdEf0123456789+/=",
  "",
].join("\n");

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: "narinfo",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: "ver_narinfo",
    orgId: "org_1",
    packageId: "pkg_demo",
    version: "narinfo",
    metadata,
    sizeBytes: 4,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const PARSED = parseNarInfoText(NARINFO_BODY);
if (!PARSED) throw new Error("fixture narinfo did not parse");
const STORED_META = buildNarInfoMeta(PARSED, { digest: NAR_DIGEST, narFileHash: FILE_HASH });

function nixContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "nix", mountPath: "nix/private" };
  return ctx;
}

function match(handlerId: string, params: Record<string, string>, path: string): RouteMatch {
  const method = handlerId === "putNar" || handlerId === "putNarinfo" ? "PUT" : "GET";
  return {
    entry: {
      method,
      pattern:
        handlerId === "cacheInfo"
          ? "/nix-cache-info"
          : handlerId.toLowerCase().includes("nar") && !handlerId.toLowerCase().includes("info")
            ? "/nar/:filename"
            : "/:narinfo",
      handlerId,
    },
    params,
    path,
  };
}

describe("Nix adapter", () => {
  test("declares cache-info + nar routes before the :narinfo catch-all", () => {
    expect(new NixAdapter().routes()).toEqual([
      { method: "GET", pattern: "/nix-cache-info", handlerId: "cacheInfo" },
      {
        method: "GET",
        pattern: "/nar/:filename",
        handlerId: "nar",
        immutableContentAddressed: true,
      },
      { method: "PUT", pattern: "/nar/:filename", handlerId: "putNar" },
      { method: "GET", pattern: "/:narinfo", handlerId: "narinfo" },
      { method: "PUT", pattern: "/:narinfo", handlerId: "putNarinfo" },
    ]);
  });

  test("reads use read permission, uploads use write, with basic auth", () => {
    const adapter = new NixAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("HEAD")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("narinfo permission targets the store-hash package scope", () => {
    const adapter = new NixAdapter();
    const m = match("narinfo", { narinfo: `${STORE_HASH}.narinfo` }, `/${STORE_HASH}.narinfo`);
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: { type: "package", packageName: `narinfo/${STORE_HASH}` },
    });
  });

  test("nar permission targets the file-hash artifact scope", () => {
    const adapter = new NixAdapter();
    const m = match("putNar", { filename: `${FILE_HASH}.nar.xz` }, `/nar/${FILE_HASH}.nar.xz`);
    expect(adapter.requiredPermission("PUT", m)).toEqual({
      action: "write",
      resource: {
        type: "artifact",
        packageName: `nar/${FILE_HASH}`,
        artifactRef: `nar/${FILE_HASH}`,
      },
    });
  });

  test("GET /nix-cache-info returns the cache descriptor, cacheable", async () => {
    const ctx = nixContext();
    const res = await new NixAdapter().handle(
      match("cacheInfo", {}, "/nix-cache-info"),
      new Request("https://registry.test/nix-cache-info"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-nix-cache-info");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await res.text()).toBe("StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n");

    if (!etag) throw new Error("expected etag");
    const cached = await new NixAdapter().handle(
      match("cacheInfo", {}, "/nix-cache-info"),
      new Request("https://registry.test/nix-cache-info", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /<storehash>.narinfo assembles the narinfo text from stored metadata", async () => {
    const ctx = nixContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(`narinfo/${STORE_HASH}`);
      return pkgRow(name);
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("narinfo");
      return versionRow(STORED_META);
    };

    const res = await new NixAdapter().handle(
      match("narinfo", { narinfo: `${STORE_HASH}.narinfo` }, `/${STORE_HASH}.narinfo`),
      new Request(`https://registry.test/${STORE_HASH}.narinfo`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-nix-narinfo");
    const text = await res.text();
    expect(text).toContain(`StorePath: /nix/store/${STORE_HASH}-hello-2.12.1`);
    expect(text).toContain(`URL: nar/${FILE_HASH}.nar.xz`);
    expect(text).toContain("Compression: xz");
    expect(text).toContain(`FileHash: sha256:${FILE_HASH}`);
    expect(text).toContain("FileSize: 41232");
    expect(text).toContain("NarSize: 226552");
    expect(text).toContain("References: ");
    expect(text).toContain("Deriver: 0000000000000000000000000000000a-hello-2.12.1.drv");
    expect(text).toContain("Sig: cache.example.org-1:AbCdEf0123456789+/=");
  });

  test("GET /<storehash>.narinfo 404s when the store hash is unknown", async () => {
    const ctx = nixContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new NixAdapter().handle(
      match("narinfo", { narinfo: `${STORE_HASH}.narinfo` }, `/${STORE_HASH}.narinfo`),
      new Request(`https://registry.test/${STORE_HASH}.narinfo`),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /<storehash> without a .narinfo suffix throws notFound", async () => {
    const ctx = nixContext();
    await expect(
      new NixAdapter().handle(
        match("narinfo", { narinfo: STORE_HASH }, `/${STORE_HASH}`),
        new Request(`https://registry.test/${STORE_HASH}`),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("GET /<storehash>.narinfo with an invalid hash throws NAME_INVALID", async () => {
    const ctx = nixContext();
    await expect(
      new NixAdapter().handle(
        match("narinfo", { narinfo: "not-a-valid-hash.narinfo" }, "/not-a-valid-hash.narinfo"),
        new Request("https://registry.test/not-a-valid-hash.narinfo"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("GET /nar/<filehash>.nar.xz serves the content-addressed NAR blob", async () => {
    const ctx = nixContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(`nar/${FILE_HASH}`);
      return pkgRow(name);
    };
    ctx.data.versions.findLive = async () =>
      versionRow({ fileHash: FILE_HASH, blobDigest: NAR_DIGEST, sizeBytes: 41232 });
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("nar-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new NixAdapter().handle(
      match("nar", { filename: `${FILE_HASH}.nar.xz` }, `/nar/${FILE_HASH}.nar.xz`),
      new Request(`https://registry.test/nar/${FILE_HASH}.nar.xz`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(NAR_DIGEST);
    expect(await res.text()).toBe("nar-bytes");
  });

  test("GET /nar/<filehash>.nar 404s when the blob is unknown", async () => {
    const ctx = nixContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new NixAdapter().handle(
      match("nar", { filename: `${FILE_HASH}.nar` }, `/nar/${FILE_HASH}.nar`),
      new Request(`https://registry.test/nar/${FILE_HASH}.nar`),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("PUT /nar/<filehash>.nar streams the NAR blob into content-addressable storage", async () => {
    const ctx = nixContext();
    const committed: { metadata?: Record<string, unknown>; scope?: string; sizeBytes?: number } =
      {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.content.storeBlobStreamWithRef = async (input): Promise<RegistryStoredBlob> => {
      // The handler must hand us the request body stream, not a buffered copy.
      expect(input.data).toBeInstanceOf(ReadableStream);
      committed.scope = input.scope;
      return { digest: NAR_DIGEST, size: 4, deduped: false, refCreated: true, blobRefId: "ref_1" };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.sizeBytes = input.sizeBytes;
      return { versionId: "ver_1" };
    };

    const res = await new NixAdapter().handle(
      match("putNar", { filename: `${FILE_HASH}.nar.xz` }, `/nar/${FILE_HASH}.nar.xz`),
      new Request(`https://registry.test/nar/${FILE_HASH}.nar.xz`, {
        method: "PUT",
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(committed.scope).toBe(`nar/${FILE_HASH}`);
    // Size is derived from the stored blob, not a pre-buffered request body.
    expect(committed.sizeBytes).toBe(4);
    expect(committed.metadata).toMatchObject({ fileHash: FILE_HASH, blobDigest: NAR_DIGEST });
  });

  test("PUT /<storehash>.narinfo persists the narinfo metadata keyed by store hash", async () => {
    const ctx = nixContext();
    const committed: { metadata?: Record<string, unknown> } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => {
      expect(name).toBe(`narinfo/${STORE_HASH}`);
      return pkgRow(name);
    };
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: `sha256:${"c".repeat(64)}`,
      size: NARINFO_BODY.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      return { versionId: "ver_1" };
    };

    const res = await new NixAdapter().handle(
      match("putNarinfo", { narinfo: `${STORE_HASH}.narinfo` }, `/${STORE_HASH}.narinfo`),
      new Request(`https://registry.test/${STORE_HASH}.narinfo`, {
        method: "PUT",
        body: NARINFO_BODY,
      }),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(committed.metadata).toMatchObject({
      storePath: `/nix/store/${STORE_HASH}-hello-2.12.1`,
      url: `nar/${FILE_HASH}.nar.xz`,
      compression: "xz",
      narFileHash: FILE_HASH,
    });
  });

  test("PUT /<storehash>.narinfo rejects an invalid narinfo body with 400", async () => {
    const ctx = nixContext();
    const res = await new NixAdapter().handle(
      match("putNarinfo", { narinfo: `${STORE_HASH}.narinfo` }, `/${STORE_HASH}.narinfo`),
      new Request(`https://registry.test/${STORE_HASH}.narinfo`, {
        method: "PUT",
        body: "not a narinfo",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("PUT /<storehash>.narinfo rejects a body whose StorePath hash mismatches", async () => {
    const ctx = nixContext();
    const otherHash = "9q8w9z0r1d2y3a4i5k6p7s8s9d0f1g2h";
    const body = NARINFO_BODY.replace(`/nix/store/${STORE_HASH}-`, `/nix/store/${otherHash}-`);
    const res = await new NixAdapter().handle(
      match("putNarinfo", { narinfo: `${STORE_HASH}.narinfo` }, `/${STORE_HASH}.narinfo`),
      new Request(`https://registry.test/${STORE_HASH}.narinfo`, { method: "PUT", body }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("full round-trip: publish a NAR then download it by file hash", async () => {
    const ctx = nixContext();
    const blobs = new Map<string, Uint8Array>();
    const versions = new Map<string, Record<string, unknown>>();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.packages.findByName = async (name) => (versions.has(name) ? pkgRow(name) : null);
    ctx.data.content.storeBlobStreamWithRef = async (input): Promise<RegistryStoredBlob> => {
      const bytes = new Uint8Array(await new Response(input.data).arrayBuffer());
      const digest = `sha256:${Bun.CryptoHasher.hash("sha256", bytes, "hex")}`;
      blobs.set(digest, bytes);
      return { digest, size: bytes.length, deduped: false, refCreated: true, blobRefId: "r" };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      versions.set(input.package.name, input.metadata);
      return { versionId: "ver_1" };
    };
    ctx.data.versions.findLive = async (pkg) => {
      const metadata = versions.get(pkg.name);
      return metadata ? versionRow(metadata) : null;
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) =>
      new Response(blobs.get(digest) ?? null, {
        status: blobs.has(digest) ? 200 : 404,
        headers: { "content-type": contentType },
      });

    const narBody = new TextEncoder().encode("nix-archive-1-fake-nar-payload");
    const put = await new NixAdapter().handle(
      match("putNar", { filename: `${FILE_HASH}.nar.xz` }, `/nar/${FILE_HASH}.nar.xz`),
      new Request(`https://registry.test/nar/${FILE_HASH}.nar.xz`, {
        method: "PUT",
        body: narBody,
      }),
      ctx,
    );
    expect(put.status).toBe(200);

    const get = await new NixAdapter().handle(
      match("nar", { filename: `${FILE_HASH}.nar.xz` }, `/nar/${FILE_HASH}.nar.xz`),
      new Request(`https://registry.test/nar/${FILE_HASH}.nar.xz`),
      ctx,
    );
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(narBody);
  });

  test("scan.referencedDigests surfaces the stored NAR blob digest", () => {
    const scan = new NixAdapter().scan;
    expect(scan?.referencedDigests?.({ blobDigest: NAR_DIGEST })).toEqual([NAR_DIGEST]);
    expect(scan?.referencedDigests?.({ fileHash: FILE_HASH })).toEqual([]);
  });
});
