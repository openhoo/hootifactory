import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryReferencedBlob,
  RegistryStoredBlob,
} from "@hootifactory/registry";
import { createTestRegistryContext, createTestRouteMatch } from "@hootifactory/registry/testing";
import { IvyAdapter } from "./ivy-adapter";
import { computeChecksumHex } from "./ivy-upload-lifecycle";

const DESCRIPTOR_PATH = "org.example/demo/1.2.3/ivy-1.2.3.xml";
const ARTIFACT_PATH = "org.example/demo/1.2.3/demo-1.2.3.jar";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ARTIFACT_BYTES = new Uint8Array([1, 2, 3, 4]);

function assetRow(scope: string, digest = DIGEST): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: null,
    packageVersionId: null,
    blobRefId: "ref_1",
    digest,
    role: "ivy_file",
    scope,
    path: scope,
    mediaType: null,
    sizeBytes: ARTIFACT_BYTES.byteLength,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function packageRow(name: string): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: name.split("#")[0] ?? null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function referencedBlob(bytes: Uint8Array, digest = DIGEST): RegistryReferencedBlob {
  return {
    digest,
    size: bytes.byteLength,
    get: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    getRange: () => {
      throw new Error("getRange not used");
    },
  };
}

describe("IvyAdapter", () => {
  test("declares upload and download routes (PUT before GET catch-all)", () => {
    expect(new IvyAdapter().routes()).toEqual([
      { method: "PUT", pattern: "/:path+", handlerId: "upload" },
      { method: "GET", pattern: "/:path+", handlerId: "download" },
    ]);
  });

  test("reads use read permission, writes use write permission, and basic auth", () => {
    const adapter = new IvyAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("scopes write permission to the org#module package for artifact files", () => {
    const adapter = new IvyAdapter();
    expect(
      adapter.requiredPermission(
        "PUT",
        createTestRouteMatch(
          { method: "PUT", pattern: "/:path+", handlerId: "upload" },
          { path: ARTIFACT_PATH },
        ),
      ),
    ).toEqual({
      action: "write",
      resource: { type: "package", packageName: "org.example#demo" },
    });
  });

  test("scopes the descriptor read to its org#module package", () => {
    const adapter = new IvyAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/:path+", handlerId: "download" },
          { path: DESCRIPTOR_PATH },
        ),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "package", packageName: "org.example#demo" },
    });
  });

  test("scopes a checksum sidecar to the package of the file it covers", () => {
    const adapter = new IvyAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/:path+", handlerId: "download" },
          { path: `${ARTIFACT_PATH}.sha1` },
        ),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "package", packageName: "org.example#demo" },
    });
  });

  test("scopes a non-coordinate path to the artifact ref", () => {
    const adapter = new IvyAdapter();
    expect(
      adapter.requiredPermission(
        "GET",
        createTestRouteMatch(
          { method: "GET", pattern: "/:path+", handlerId: "download" },
          { path: "org.example/demo/maven-metadata.xml" },
        ),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "org.example/demo/maven-metadata.xml" },
    });
  });

  test("downloads a stored descriptor via its path-scoped asset", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("ivy_file");
      expect(scope).toBe(DESCRIPTOR_PATH);
      return assetRow(scope);
    };
    ctx.data.content.blobRefExists = async () => true;
    const res = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: DESCRIPTOR_PATH },
      ),
      new Request(`https://r.test/ivy/o/r/${DESCRIPTOR_PATH}`),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  test("serves a .sha1 sidecar computed from the stored base blob", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async ({ scope }) => {
      expect(scope).toBe(ARTIFACT_PATH);
      return assetRow(scope);
    };
    ctx.data.content.getBlobRef = async ({ scope }) => {
      expect(scope).toBe(ARTIFACT_PATH);
      return referencedBlob(ARTIFACT_BYTES);
    };
    const res = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: `${ARTIFACT_PATH}.sha1` },
      ),
      new Request(`https://r.test/ivy/o/r/${ARTIFACT_PATH}.sha1`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(computeChecksumHex(ARTIFACT_BYTES, "sha1"));
    expect(res.headers.get("etag")).toBeTruthy();
  });

  test("serves a .md5 sidecar computed from the stored base blob", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = async () => assetRow(ARTIFACT_PATH);
    ctx.data.content.getBlobRef = async () => referencedBlob(ARTIFACT_BYTES);
    const res = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: `${ARTIFACT_PATH}.md5` },
      ),
      new Request(`https://r.test/ivy/o/r/${ARTIFACT_PATH}.md5`),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(computeChecksumHex(ARTIFACT_BYTES, "md5"));
  });

  test("checksum request 404s when the base file is missing (dispatch maps it to 404)", async () => {
    const ctx = createTestRegistryContext();
    // No asset for the base path -> readIvyBlobBytes returns null.
    const handling = new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: `${ARTIFACT_PATH}.sha1` },
      ),
      new Request(`https://r.test/ivy/o/r/${ARTIFACT_PATH}.sha1`),
      ctx,
    );
    await expect(handling).rejects.toMatchObject({ status: 404 });
  });

  test("download 404s for a missing file (dispatch maps it to 404)", async () => {
    const ctx = createTestRegistryContext();
    const handling = new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: ARTIFACT_PATH },
      ),
      new Request(`https://r.test/ivy/o/r/${ARTIFACT_PATH}`),
      ctx,
    );
    await expect(handling).rejects.toMatchObject({ status: 404 });
  });

  test("rejects an unsafe (traversal) path with NAME_INVALID", async () => {
    const ctx = createTestRegistryContext();
    await expect(
      new IvyAdapter().handle(
        createTestRouteMatch(
          { method: "GET", pattern: "/:path+", handlerId: "download" },
          { path: "org/../etc/passwd" },
        ),
        new Request("https://r.test/ivy/o/r/org/../etc/passwd"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });

  test("references the descriptor and every artifact digest a version owns", () => {
    const referenced = new IvyAdapter().scan?.referencedDigests;
    expect(referenced?.({})).toEqual([]);
    expect(referenced?.({ descriptorDigest: "sha256:desc" })).toEqual(["sha256:desc"]);
    expect(
      referenced?.({
        descriptorDigest: "sha256:desc",
        artifactDigests: ["sha256:jar", "sha256:src", "sha256:jar", 7],
      }),
    ).toEqual(["sha256:desc", "sha256:jar", "sha256:src"]);
  });

  test("publish (PUT descriptor) projects a package/version, then it downloads back", async () => {
    const ctx = createTestRegistryContext();
    const stored: RegistryStoredBlob = {
      digest: DIGEST,
      size: 8,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    };
    const captured: {
      assetScope?: string;
      versionName?: string;
      version?: string;
      metadata?: Record<string, unknown>;
      scan?: { digest?: string; name?: string; version?: string; mediaType?: string };
    } = {};
    const descriptorBody = `<ivy-module version="2.0"><info organisation="org.example" module="demo" revision="1.2.3"/></ivy-module>`;
    ctx.data.content.storeBlobWithRef = async (input) => {
      expect(input.kind).toBe("ivy_file");
      expect(input.scope).toBe(DESCRIPTOR_PATH);
      return stored;
    };
    ctx.data.assets.upsert = async (input) => {
      captured.assetScope = input.scope ?? "";
      return assetRow(input.scope ?? "");
    };
    ctx.data.packages.findOrCreate = async ({ name }) => {
      captured.versionName = name;
      return packageRow(name);
    };
    ctx.data.versions.upsert = async (input) => {
      captured.version = input.version;
      captured.metadata = input.metadata;
      return "ver_1";
    };
    ctx.enqueueScan = async (input) => {
      captured.scan = input;
    };

    const publishRes = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "PUT", pattern: "/:path+", handlerId: "upload" },
        { path: DESCRIPTOR_PATH },
      ),
      new Request(`https://r.test/ivy/o/r/${DESCRIPTOR_PATH}`, {
        method: "PUT",
        body: descriptorBody,
      }),
      ctx,
    );
    expect(publishRes.status).toBe(201);
    expect(captured.assetScope).toBe(DESCRIPTOR_PATH);
    expect(captured.versionName).toBe("org.example#demo");
    expect(captured.version).toBe("1.2.3");
    expect(captured.metadata).toMatchObject({
      organisation: "org.example",
      module: "demo",
      revision: "1.2.3",
      descriptorDigest: DIGEST,
    });
    expect(captured.scan).toEqual({
      digest: DIGEST,
      name: "org.example#demo",
      version: "1.2.3",
      mediaType: "application/xml",
    });

    // Round-trip: the stored descriptor is now served back from its asset.
    ctx.data.assets.findByScope = async ({ scope }) => assetRow(scope);
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) =>
      new Response(`blob:${digest}`, { headers: { "content-type": contentType } });
    ctx.data.content.blobRefExists = async () => true;
    const downloadRes = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "GET", pattern: "/:path+", handlerId: "download" },
        { path: DESCRIPTOR_PATH },
      ),
      new Request(`https://r.test/ivy/o/r/${DESCRIPTOR_PATH}`),
      ctx,
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toContain("application/xml");
    expect(await downloadRes.text()).toBe(`blob:${DIGEST}`);
  });

  test("PUT of an artifact streams the blob and scans the jar bytes", async () => {
    const ctx = createTestRegistryContext();
    const stored: RegistryStoredBlob = {
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    };
    const captured: { mode?: string; scan?: unknown } = {};
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      captured.mode = "stream";
      expect(input.data).toBeInstanceOf(ReadableStream);
      return stored;
    };
    ctx.data.assets.upsert = async (input) => assetRow(input.scope ?? "");
    ctx.enqueueScan = async (input) => {
      captured.scan = input;
    };

    const res = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "PUT", pattern: "/:path+", handlerId: "upload" },
        { path: ARTIFACT_PATH },
      ),
      new Request(`https://r.test/ivy/o/r/${ARTIFACT_PATH}`, {
        method: "PUT",
        body: ARTIFACT_BYTES,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(captured.mode).toBe("stream");
    expect(captured.scan).toEqual({
      digest: DIGEST,
      name: "org.example#demo",
      version: "1.2.3",
      mediaType: "application/java-archive",
    });
  });

  test("PUT of a checksum sidecar stores it without scanning or projecting a version", async () => {
    const ctx = createTestRegistryContext();
    const stored: RegistryStoredBlob = {
      digest: DIGEST,
      size: 40,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    };
    const captured: { scans: unknown[]; versions: number } = { scans: [], versions: 0 };
    ctx.data.content.storeBlobStreamWithRef = async () => stored;
    ctx.data.assets.upsert = async (input) => assetRow(input.scope ?? "");
    ctx.data.versions.upsert = async () => {
      captured.versions += 1;
      return "ver_1";
    };
    ctx.enqueueScan = async (input) => {
      captured.scans.push(input);
    };

    const res = await new IvyAdapter().handle(
      createTestRouteMatch(
        { method: "PUT", pattern: "/:path+", handlerId: "upload" },
        { path: `${ARTIFACT_PATH}.sha1` },
      ),
      new Request(`https://r.test/ivy/o/r/${ARTIFACT_PATH}.sha1`, {
        method: "PUT",
        body: "deadbeef",
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(captured.scans).toEqual([]);
    expect(captured.versions).toBe(0);
  });
});
