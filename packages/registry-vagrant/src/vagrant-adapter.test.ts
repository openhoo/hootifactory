import { describe, expect, test } from "bun:test";
import {
  computeDigest,
  digestHex,
  type RegistryPackageRow,
  type RegistryPackageVersionRow,
  type RegistryStoredBlob,
  type RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { VagrantAdapter } from "./vagrant-adapter";
import { boxScope } from "./vagrant-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);
const NAME = "hashicorp/bionic64";

function pkgRow(name = NAME): RegistryPackageRow {
  return {
    id: "pkg_1",
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

function versionRow(version: string, metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_1",
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

function storedBlob(): RegistryStoredBlob {
  return { digest: DIGEST, size: 4, deduped: false, refCreated: true, blobRefId: "ref_1" };
}

function vagrantContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "vagrant", mountPath: "vagrant/private" };
  return ctx;
}

const metadataMatch = {
  entry: { method: "GET", pattern: "/:user/:box", handlerId: "metadata" },
  params: { user: "hashicorp", box: "bionic64" },
  path: "/hashicorp/bionic64",
} satisfies RouteMatch;

const cloudMetadataMatch = {
  entry: { method: "GET", pattern: "/api/v1/box/:user/:box", handlerId: "cloudMetadata" },
  params: { user: "hashicorp", box: "bionic64" },
  path: "/api/v1/box/hashicorp/bionic64",
} satisfies RouteMatch;

const downloadMatch = {
  entry: { method: "GET", pattern: "/:user/:box/:version/:provider", handlerId: "download" },
  params: { user: "hashicorp", box: "bionic64", version: "1.2.3", provider: "virtualbox" },
  path: "/hashicorp/bionic64/1.2.3/virtualbox",
} satisfies RouteMatch;

const publishMatch = {
  entry: { method: "PUT", pattern: "/:user/:box/:version/:provider", handlerId: "publish" },
  params: { user: "hashicorp", box: "bionic64", version: "1.2.3", provider: "virtualbox" },
  path: "/hashicorp/bionic64/1.2.3/virtualbox",
} satisfies RouteMatch;

describe("Vagrant adapter", () => {
  test("declares the cloud read alias first, then 4-seg download/publish before 2-seg metadata", () => {
    expect(new VagrantAdapter().routes()).toEqual([
      { method: "GET", pattern: "/api/v1/box/:user/:box", handlerId: "cloudMetadata" },
      { method: "GET", pattern: "/:user/:box/:version/:provider", handlerId: "download" },
      { method: "PUT", pattern: "/:user/:box/:version/:provider", handlerId: "publish" },
      { method: "GET", pattern: "/:user/:box", handlerId: "metadata" },
    ]);
  });

  test("declares only the virtualizable capability (no unbacked proxyable claim)", () => {
    const { capabilities } = new VagrantAdapter();
    expect(capabilities.virtualizable).toBe(true);
    // proxyable must stay false: there is no proxyIngest handler to back it.
    expect(capabilities.proxyable).toBe(false);
  });

  test("uses read permissions for reads, write for publish, and basic auth", () => {
    const adapter = new VagrantAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("metadata permission targets the box package", () => {
    const adapter = new VagrantAdapter();
    expect(adapter.requiredPermission("GET", metadataMatch)).toEqual({
      action: "read",
      resource: { type: "package", packageName: NAME },
    });
  });

  test("download permission targets the provider artifact ref", () => {
    const adapter = new VagrantAdapter();
    expect(adapter.requiredPermission("GET", downloadMatch)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: NAME,
        artifactRef: "hashicorp/bionic64@1.2.3/virtualbox",
      },
    });
  });

  test("publish permission targets the provider artifact ref with write action", () => {
    const adapter = new VagrantAdapter();
    expect(adapter.requiredPermission("PUT", publishMatch)).toEqual({
      action: "write",
      resource: {
        type: "artifact",
        packageName: NAME,
        artifactRef: "hashicorp/bionic64@1.2.3/virtualbox",
      },
    });
  });

  test("GET /:user/:box aggregates all live versions with hosted urls + checksums", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(NAME);
      return pkgRow();
    };
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      // Newest-first ordering. The newest version carries the description.
      return [
        versionRow("2.0.0", {
          description: "Ubuntu bionic",
          providers: {
            virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 },
            libvirt: { blobDigest: DIGEST, sha256: "b".repeat(64), sizeBytes: 4 },
          },
        }),
        versionRow("1.2.3", {
          providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 } },
        }),
      ];
    };

    const res = await new VagrantAdapter().handle(
      metadataMatch,
      new Request("https://registry.test/hashicorp/bionic64"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await res.json()).toEqual({
      name: NAME,
      description: "Ubuntu bionic",
      versions: [
        {
          version: "2.0.0",
          providers: [
            {
              name: "libvirt",
              url: "https://registry.example.test/vagrant/private/hashicorp/bionic64/2.0.0/libvirt",
              checksum_type: "sha256",
              checksum: "b".repeat(64),
            },
            {
              name: "virtualbox",
              url: "https://registry.example.test/vagrant/private/hashicorp/bionic64/2.0.0/virtualbox",
              checksum_type: "sha256",
              checksum: HEX,
            },
          ],
        },
        {
          version: "1.2.3",
          providers: [
            {
              name: "virtualbox",
              url: "https://registry.example.test/vagrant/private/hashicorp/bionic64/1.2.3/virtualbox",
              checksum_type: "sha256",
              checksum: HEX,
            },
          ],
        },
      ],
    });

    if (!etag) throw new Error("expected ETag");
    const cached = await new VagrantAdapter().handle(
      metadataMatch,
      new Request("https://registry.test/hashicorp/bionic64", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET /:user/:box 404s when the package is unknown", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new VagrantAdapter().handle(
      metadataMatch,
      new Request("https://registry.test/hashicorp/bionic64"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /:user/:box 404s when no live version carries providers", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.listLive = async () => [versionRow("1.2.3", { providers: {} })];
    const res = await new VagrantAdapter().handle(
      metadataMatch,
      new Request("https://registry.test/hashicorp/bionic64"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /api/v1/box/:user/:box serves the Vagrant Cloud box shape for short-name resolution", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(NAME);
      return pkgRow();
    };
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "desc" });
      return [
        versionRow("2.0.0", {
          description: "Ubuntu bionic",
          providers: {
            virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 },
            libvirt: { blobDigest: DIGEST, sha256: "b".repeat(64), sizeBytes: 4 },
          },
        }),
        versionRow("1.2.3", {
          providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 } },
        }),
      ];
    };

    const res = await new VagrantAdapter().handle(
      cloudMetadataMatch,
      new Request("https://registry.test/api/v1/box/hashicorp/bionic64"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("etag")).toBeTruthy();
    // Cloud shape: `tag`+`name` at top level, providers keyed by `download_url`,
    // pointing at the same hosted download route as the catalog document.
    expect(await res.json()).toEqual({
      tag: NAME,
      name: NAME,
      description: "Ubuntu bionic",
      versions: [
        {
          version: "2.0.0",
          providers: [
            {
              name: "libvirt",
              download_url:
                "https://registry.example.test/vagrant/private/hashicorp/bionic64/2.0.0/libvirt",
              checksum_type: "sha256",
              checksum: "b".repeat(64),
            },
            {
              name: "virtualbox",
              download_url:
                "https://registry.example.test/vagrant/private/hashicorp/bionic64/2.0.0/virtualbox",
              checksum_type: "sha256",
              checksum: HEX,
            },
          ],
        },
        {
          version: "1.2.3",
          providers: [
            {
              name: "virtualbox",
              download_url:
                "https://registry.example.test/vagrant/private/hashicorp/bionic64/1.2.3/virtualbox",
              checksum_type: "sha256",
              checksum: HEX,
            },
          ],
        },
      ],
    });
  });

  test("GET /api/v1/box/:user/:box 404s when the package is unknown", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new VagrantAdapter().handle(
      cloudMetadataMatch,
      new Request("https://registry.test/api/v1/box/hashicorp/bionic64"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET /:user/:box with an invalid name segment throws NAME_INVALID", async () => {
    const ctx = vagrantContext();
    await expect(
      new VagrantAdapter().handle(
        {
          entry: { method: "GET", pattern: "/:user/:box", handlerId: "metadata" },
          params: { user: "bad user", box: "bionic64" },
          path: "/bad%20user/bionic64",
        },
        new Request("https://registry.test/bad%20user/bionic64"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("download resolves the stored blob for the matching provider", async () => {
    const ctx = vagrantContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow("1.2.3", {
        providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 } },
      });
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("box-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new VagrantAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/hashicorp/bionic64/1.2.3/virtualbox"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("box-bytes");
  });

  test("download 404s when the version is missing or not live", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async () => null;
    const res = await new VagrantAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/hashicorp/bionic64/1.2.3/virtualbox"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download 404s when the requested provider is not stored on the version", async () => {
    const ctx = vagrantContext();
    ctx.data.packages.findByName = async () => pkgRow();
    ctx.data.versions.findLive = async () =>
      versionRow("1.2.3", {
        providers: { libvirt: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 } },
      });
    const res = await new VagrantAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/hashicorp/bionic64/1.2.3/virtualbox"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download with an invalid provider name throws NAME_INVALID", async () => {
    const ctx = vagrantContext();
    await expect(
      new VagrantAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/:user/:box/:version/:provider",
            handlerId: "download",
          },
          params: { user: "hashicorp", box: "bionic64", version: "1.2.3", provider: "bad/prov" },
          path: "/hashicorp/bionic64/1.2.3/bad%2Fprov",
        },
        new Request("https://registry.test/hashicorp/bionic64/1.2.3/bad%2Fprov"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("scan.referencedDigests surfaces every provider blob digest", () => {
    const scan = new VagrantAdapter().scan;
    expect(
      scan?.referencedDigests?.({
        providers: {
          virtualbox: { blobDigest: DIGEST, sha256: HEX },
          libvirt: { blobDigest: DIGEST, sha256: HEX },
        },
      }),
    ).toEqual([DIGEST, DIGEST]);
    expect(scan?.referencedDigests?.({ version: "1.0.0" })).toEqual([]);
  });
});

function publishRequest(body: Uint8Array = new Uint8Array([1, 2, 3, 4])): Request {
  return new Request("https://registry.test/hashicorp/bionic64/1.2.3/virtualbox", {
    method: "PUT",
    body,
  });
}

describe("Vagrant publish", () => {
  test("publishes a new (version, provider), persisting metadata and enqueuing a scan", async () => {
    const ctx = vagrantContext();
    let createdMetadata: Record<string, unknown> | undefined;
    let createdSize: number | undefined;
    let scanned: { digest: string } | undefined;
    let asset: { scope?: string } | undefined;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      expect(input.kind).toBe("vagrant_box");
      expect(input.scope).toBe(boxScope(NAME, "1.2.3", "virtualbox"));
      return storedBlob();
    };
    ctx.data.packages.findOrCreate = async ({ name }) => {
      expect(name).toBe(NAME);
      return pkgRow();
    };
    ctx.data.versions.create = async (input) => {
      createdMetadata = input.metadata;
      createdSize = input.sizeBytes;
      return "ver_new";
    };
    ctx.data.assets.upsert = async (input) => {
      asset = input;
      scanned = input.scanInput;
      return {} as never;
    };

    const res = await new VagrantAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      name: NAME,
      version: "1.2.3",
      provider: "virtualbox",
    });
    expect(createdMetadata).toEqual({
      providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 } },
    });
    expect(createdSize).toBe(4);
    expect(asset?.scope).toBe(boxScope(NAME, "1.2.3", "virtualbox"));
    expect(scanned?.digest).toBe(DIGEST);
  });

  test("adds a second provider to an existing version via patch and grows the size", async () => {
    const ctx = vagrantContext();
    let patchedMeta: Record<string, unknown> | undefined;
    let patchedSize: number | undefined;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => storedBlob();
    ctx.data.packages.findOrCreate = async () => pkgRow();
    // Version already exists -> create() returns null, lifecycle falls back to patch().
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const update = patch({
        id: "ver_1",
        deletedAt: null,
        metadata: {
          providers: { libvirt: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 5 } },
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

    const res = await new VagrantAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(201);
    expect(patchedMeta?.providers).toEqual({
      libvirt: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 5 },
      virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 },
    });
    // Size recomputed from the merged providers: existing 5 + new 4-byte box.
    expect(patchedSize).toBe(9);
  });

  test("rejects a duplicate provider (same version) with 409 and releases the ref", async () => {
    const ctx = vagrantContext();
    let released = false;
    ctx.data.assets.findByScope = async () => null;
    ctx.data.content.storeBlobStreamWithRef = async () => storedBlob();
    ctx.data.content.releaseBlobRef = async () => {
      released = true;
    };
    ctx.data.packages.findOrCreate = async () => pkgRow();
    ctx.data.versions.create = async () => null;
    ctx.data.versions.patch = async ({ patch }) => {
      const update = patch({
        id: "ver_1",
        deletedAt: null,
        metadata: { providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX } } },
      });
      return update.result;
    };

    const res = await new VagrantAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(409);
    expect(released).toBe(true);
  });

  test("rejects re-publishing an already-stored box provider asset with 409", async () => {
    const ctx = vagrantContext();
    ctx.data.assets.findByScope = async (input) => {
      expect(input.includeDeleted).toBe(true);
      return { scope: input.scope } as never;
    };
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new Error("should not store when the box provider already exists");
    };
    const res = await new VagrantAdapter().handle(publishMatch, publishRequest(), ctx);
    expect(res.status).toBe(409);
  });

  test("rejects an empty box artifact with 400 and releases the stored ref", async () => {
    const ctx = vagrantContext();
    let released = false;
    ctx.data.assets.findByScope = async () => null;
    // A drained-empty body stores a zero-size blob; the lifecycle rejects it.
    ctx.data.content.storeBlobStreamWithRef = async () => ({ ...storedBlob(), size: 0 });
    ctx.data.content.releaseBlobRef = async () => {
      released = true;
    };
    const res = await new VagrantAdapter().handle(
      publishMatch,
      publishRequest(new Uint8Array(0)),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(released).toBe(true);
  });

  test("publish rejects an invalid version before storing anything", async () => {
    const ctx = vagrantContext();
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new Error("should not store on an invalid version");
    };
    await expect(
      new VagrantAdapter().handle(
        {
          entry: {
            method: "PUT",
            pattern: "/:user/:box/:version/:provider",
            handlerId: "publish",
          },
          params: {
            user: "hashicorp",
            box: "bionic64",
            version: "bad version",
            provider: "virtualbox",
          },
          path: "/hashicorp/bionic64/bad%20version/virtualbox",
        },
        publishRequest(),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/**
 * Wire a context backed by a tiny in-memory store so a publish actually threads
 * its content-addressed digest through to the reads: publish computes the real
 * sha256 of the body and records the bytes by digest, and `serveBlobIfClean`
 * replays those exact bytes for that digest. This lets a chained
 * publish -> read-metadata -> download prove the binding a real Vagrant client
 * relies on: the bytes stored at publish are the bytes served at download, and
 * their sha256 equals the `checksum` advertised in the metadata for that provider.
 */
function roundTripContext() {
  const ctx = vagrantContext();
  const blobs = new Map<string, Uint8Array>();
  const versions = new Map<string, RegistryPackageVersionRow>();
  const pkg = pkgRow();

  ctx.data.packages.findByName = async () => (versions.size > 0 ? pkg : null);
  ctx.data.packages.findOrCreate = async () => pkg;
  ctx.data.assets.findByScope = async () => null;
  ctx.data.assets.upsert = async () => ({}) as never;
  ctx.enqueueScan = async () => {};

  ctx.data.content.storeBlobStreamWithRef = async ({ data }) => {
    const bytes = new Uint8Array(await new Response(data).arrayBuffer());
    const digest = computeDigest(bytes);
    blobs.set(digest, bytes);
    return { digest, size: bytes.byteLength, deduped: false, refCreated: true, blobRefId: "ref_1" };
  };
  ctx.data.content.blobRefExists = async () => true;
  ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
    const bytes = blobs.get(digest);
    if (!bytes) return new Response("Not Found", { status: 404 });
    return new Response(bytes, { headers: { "content-type": contentType } });
  };

  ctx.data.versions.create = async ({ version, metadata }) => {
    if (versions.has(version)) return null;
    versions.set(version, versionRow(version, metadata));
    return `ver_${version}`;
  };
  ctx.data.versions.listLive = async () =>
    [...versions.values()].sort((a, b) => (a.version < b.version ? 1 : -1));
  ctx.data.versions.findLive = async (_pkg, version) => versions.get(version) ?? null;

  return ctx;
}

describe("Vagrant round-trip", () => {
  test("publish -> metadata -> cloud read -> download keeps bytes and checksum consistent", async () => {
    const ctx = roundTripContext();
    const adapter = new VagrantAdapter();
    const body = new Uint8Array([10, 20, 30, 40, 50]);
    const expectedChecksum = digestHex(computeDigest(body));

    // 1) Publish a (version, provider) box.
    const published = await adapter.handle(publishMatch, publishRequest(body), ctx);
    expect(published.status).toBe(201);

    // 2) Read the box-catalog metadata and pull the provider's advertised url/checksum.
    const meta = await adapter.handle(
      metadataMatch,
      new Request("https://registry.test/hashicorp/bionic64"),
      ctx,
    );
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      versions: {
        version: string;
        providers: { name: string; url: string; checksum_type: string; checksum: string }[];
      }[];
    };
    const provider = metaBody.versions[0]?.providers.find((p) => p.name === "virtualbox");
    expect(provider).toBeDefined();
    if (!provider) throw new Error("expected virtualbox provider");
    expect(provider.checksum_type).toBe("sha256");
    // The advertised checksum is the true sha256 of the published bytes.
    expect(provider.checksum).toBe(expectedChecksum);

    // 3) The Cloud read alias resolves the same box with the same checksum + url.
    const cloud = await adapter.handle(
      cloudMetadataMatch,
      new Request("https://registry.test/api/v1/box/hashicorp/bionic64"),
      ctx,
    );
    expect(cloud.status).toBe(200);
    const cloudBody = (await cloud.json()) as {
      tag: string;
      versions: { providers: { name: string; download_url: string; checksum: string }[] }[];
    };
    const cloudProvider = cloudBody.versions[0]?.providers.find((p) => p.name === "virtualbox");
    expect(cloudBody.tag).toBe(NAME);
    expect(cloudProvider?.checksum).toBe(expectedChecksum);
    // The Cloud `download_url` is the same hosted route as the catalog `url`.
    expect(cloudProvider?.download_url).toBe(provider.url);

    // 4) Download via the provider url and verify the served bytes hash to the
    //    advertised checksum -- the binding a real `vagrant box add` verifies.
    const downloadPath = new URL(provider.url).pathname.replace("/vagrant/private", "");
    const segments = downloadPath.split("/").filter(Boolean);
    const downloaded = await adapter.handle(
      {
        entry: {
          method: "GET",
          pattern: "/:user/:box/:version/:provider",
          handlerId: "download",
        },
        params: {
          user: segments[0] ?? "",
          box: segments[1] ?? "",
          version: segments[2] ?? "",
          provider: segments[3] ?? "",
        },
        path: downloadPath,
      },
      new Request(`https://registry.test${downloadPath}`),
      ctx,
    );
    expect(downloaded.status).toBe(200);
    const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
    expect(downloadedBytes).toEqual(body);
    expect(digestHex(computeDigest(downloadedBytes))).toBe(provider.checksum);
  });
});
