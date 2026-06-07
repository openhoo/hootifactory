import { describe, expect, test } from "bun:test";
import type {
  RegistryAssetRow,
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { P2Adapter } from "./p2-adapter";
import { P2_JAR_KIND } from "./p2-publish-lifecycle";
import type { P2VersionMeta } from "./p2-validation";
import { zipSingleEntry } from "./p2-xml";

const DIGEST = `sha256:${"b".repeat(64)}`;

function bundleJar(symbolicName: string, version: string): Uint8Array {
  const manifest = [
    "Manifest-Version: 1.0",
    `Bundle-SymbolicName: ${symbolicName}`,
    `Bundle-Version: ${version}`,
    "",
  ].join("\r\n");
  return zipSingleEntry("META-INF/MANIFEST.MF", new TextEncoder().encode(manifest));
}

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

function versionRow(metadata: P2VersionMeta): RegistryPackageVersionRow {
  return {
    id: `ver_${metadata.version}`,
    orgId: "org_1",
    packageId: `pkg_${metadata.symbolicName}`,
    version: metadata.version,
    metadata,
    sizeBytes: metadata.sizeBytes,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function meta(over: Partial<P2VersionMeta> = {}): P2VersionMeta {
  return {
    symbolicName: "org.example.bundle",
    version: "1.2.3",
    kind: "bundle",
    filename: "org.example.bundle_1.2.3.jar",
    blobDigest: DIGEST,
    sizeBytes: 4,
    ...over,
  };
}

function assetRow(metadata: P2VersionMeta): RegistryAssetRow {
  return {
    id: "asset_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    packageId: `pkg_${metadata.symbolicName}`,
    packageVersionId: `ver_${metadata.version}`,
    blobRefId: "ref_1",
    digest: metadata.blobDigest,
    role: P2_JAR_KIND,
    scope: `${metadata.kind === "feature" ? "features" : "plugins"}/${metadata.filename}`,
    path: null,
    mediaType: "application/java-archive",
    sizeBytes: metadata.sizeBytes,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function p2Context() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "p2", mountPath: "acme/p2" };
  return ctx;
}

function match(
  entry: RouteMatch["entry"],
  params: Record<string, string>,
  path: string,
): RouteMatch {
  return { entry, params, path };
}

describe("P2 adapter", () => {
  test("declares index routes before the plugins/features catch-alls", () => {
    expect(new P2Adapter().routes()).toEqual([
      { method: "GET", pattern: "/content.xml", handlerId: "contentXml" },
      { method: "GET", pattern: "/content.jar", handlerId: "contentJar" },
      { method: "GET", pattern: "/artifacts.xml", handlerId: "artifactsXml" },
      { method: "GET", pattern: "/artifacts.jar", handlerId: "artifactsJar" },
      { method: "GET", pattern: "/plugins/:filename", handlerId: "downloadBundle" },
      { method: "GET", pattern: "/features/:filename", handlerId: "downloadFeature" },
      { method: "PUT", pattern: "/plugins/:filename", handlerId: "publishBundle" },
      { method: "PUT", pattern: "/features/:filename", handlerId: "publishFeature" },
    ]);
  });

  test("capabilities are proxyable + virtualizable, not content-addressable/resumable", () => {
    expect(new P2Adapter().capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
  });

  test("uses read for GET, write for PUT, and basic auth", () => {
    const adapter = new P2Adapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the bundle artifact scope", () => {
    const adapter = new P2Adapter();
    const m = match(
      { method: "GET", pattern: "/plugins/:filename", handlerId: "downloadBundle" },
      { filename: "org.example.bundle_1.2.3.jar" },
      "/plugins/org.example.bundle_1.2.3.jar",
    );
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: "plugins/org.example.bundle_1.2.3.jar" },
    });
  });

  test("publish permission targets the feature artifact scope", () => {
    const adapter = new P2Adapter();
    const m = match(
      { method: "PUT", pattern: "/features/:filename", handlerId: "publishFeature" },
      { filename: "org.example.feature_1.2.3.jar" },
      "/features/org.example.feature_1.2.3.jar",
    );
    expect(adapter.requiredPermission("PUT", m)).toEqual({
      action: "write",
      resource: { type: "artifact", artifactRef: "features/org.example.feature_1.2.3.jar" },
    });
  });

  test("scan.referencedDigests surfaces the stored blob digest", () => {
    const scan = new P2Adapter().scan;
    expect(scan?.referencedDigests?.({ ...meta() })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ symbolicName: "a.b" })).toEqual([]);
  });

  test("GET /content.xml regenerates the metadata repository over live units", async () => {
    const ctx = p2Context();
    ctx.data.packages.listNames = async () => [{ name: "org.example.bundle" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [versionRow(meta())];
    };

    const res = await new P2Adapter().handle(
      match(
        { method: "GET", pattern: "/content.xml", handlerId: "contentXml" },
        {},
        "/content.xml",
      ),
      new Request("https://registry.test/content.xml"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain('<unit id="org.example.bundle" version="1.2.3">');
    expect(body).toContain(
      '<artifact classifier="osgi.bundle" id="org.example.bundle" version="1.2.3"/>',
    );
    expect(res.headers.get("etag")).toBeTruthy();
  });

  test("GET /artifacts.xml regenerates the artifact repository", async () => {
    const ctx = p2Context();
    ctx.data.packages.listNames = async () => [{ name: "org.example.bundle" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(meta())];

    const res = await new P2Adapter().handle(
      match(
        { method: "GET", pattern: "/artifacts.xml", handlerId: "artifactsXml" },
        {},
        "/artifacts.xml",
      ),
      new Request("https://registry.test/artifacts.xml"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<?artifactRepository version='1.1.0'?>");
    expect(body).toContain(
      '<artifact classifier="osgi.bundle" id="org.example.bundle" version="1.2.3">',
    );
    expect(body).toContain("<property name='download.size' value='4'/>");
  });

  test("GET /content.jar returns a jar-zipped copy of content.xml", async () => {
    const ctx = p2Context();
    ctx.data.packages.listNames = async () => [{ name: "org.example.bundle" }];
    ctx.data.packages.findByName = async (name) => pkgRow(name);
    ctx.data.versions.listLive = async () => [versionRow(meta())];

    const res = await new P2Adapter().handle(
      match(
        { method: "GET", pattern: "/content.jar", handlerId: "contentJar" },
        {},
        "/content.jar",
      ),
      new Request("https://registry.test/content.jar"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/java-archive");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Valid zip: local file header signature at the start.
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    if (!etag) throw new Error("expected ETag");
    const cached = await new P2Adapter().handle(
      match(
        { method: "GET", pattern: "/content.jar", handlerId: "contentJar" },
        {},
        "/content.jar",
      ),
      new Request("https://registry.test/content.jar", { headers: { "if-none-match": etag } }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("PUT /plugins/<file> parses the OSGi manifest and stores derived metadata", async () => {
    const ctx = p2Context();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const res = await new P2Adapter().handle(
      match(
        { method: "PUT", pattern: "/plugins/:filename", handlerId: "publishBundle" },
        { filename: "anything.jar" },
        "/plugins/anything.jar",
      ),
      new Request("https://registry.test/plugins/anything.jar", {
        method: "PUT",
        headers: { "content-type": "application/java-archive" },
        body: bundleJar("org.example.bundle", "1.2.3"),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      symbolicName: "org.example.bundle",
      version: "1.2.3",
      kind: "bundle",
      filename: "org.example.bundle_1.2.3.jar",
    });
    expect(committed.scan).toEqual({
      name: "org.example.bundle",
      version: "1.2.3",
      mediaType: "application/java-archive",
    });
    expect(committed.metadata).toMatchObject({
      symbolicName: "org.example.bundle",
      version: "1.2.3",
      kind: "bundle",
      filename: "org.example.bundle_1.2.3.jar",
      blobDigest: DIGEST,
    });
  });

  test("PUT returns 422 when the jar has no parseable OSGi manifest", async () => {
    const ctx = p2Context();
    const res = await new P2Adapter().handle(
      match(
        { method: "PUT", pattern: "/plugins/:filename", handlerId: "publishBundle" },
        { filename: "bad.jar" },
        "/plugins/bad.jar",
      ),
      new Request("https://registry.test/plugins/bad.jar", {
        method: "PUT",
        headers: { "content-type": "application/java-archive" },
        body: zipSingleEntry("readme.txt", new TextEncoder().encode("not a bundle")),
      }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  test("PUT returns 409 when the version already exists", async () => {
    const ctx = p2Context();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;
    const res = await new P2Adapter().handle(
      match(
        { method: "PUT", pattern: "/plugins/:filename", handlerId: "publishBundle" },
        { filename: "anything.jar" },
        "/plugins/anything.jar",
      ),
      new Request("https://registry.test/plugins/anything.jar", {
        method: "PUT",
        headers: { "content-type": "application/java-archive" },
        body: bundleJar("org.example.bundle", "1.2.3"),
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("GET /plugins/<file> serves the stored jar blob", async () => {
    const ctx = p2Context();
    const served: { digest?: string } = {};
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe(P2_JAR_KIND);
      expect(scope).toBe("plugins/org.example.bundle_1.2.3.jar");
      return assetRow(meta());
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("jar-bytes", { headers: { "content-type": contentType } });
    };

    const res = await new P2Adapter().handle(
      match(
        { method: "GET", pattern: "/plugins/:filename", handlerId: "downloadBundle" },
        { filename: "org.example.bundle_1.2.3.jar" },
        "/plugins/org.example.bundle_1.2.3.jar",
      ),
      new Request("https://registry.test/plugins/org.example.bundle_1.2.3.jar"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("jar-bytes");
  });

  test("GET /features/<file> resolves against the features scope", async () => {
    const ctx = p2Context();
    ctx.data.assets.findByScope = async ({ scope }) => {
      expect(scope).toBe("features/org.example.feature_1.2.3.jar");
      return assetRow(
        meta({
          symbolicName: "org.example.feature",
          kind: "feature",
          filename: "org.example.feature_1.2.3.jar",
        }),
      );
    };
    ctx.data.content.blobRefExists = async () => true;

    const res = await new P2Adapter().handle(
      match(
        { method: "GET", pattern: "/features/:filename", handlerId: "downloadFeature" },
        { filename: "org.example.feature_1.2.3.jar" },
        "/features/org.example.feature_1.2.3.jar",
      ),
      new Request("https://registry.test/features/org.example.feature_1.2.3.jar"),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  test("GET /plugins/<file> 404s when the asset is unknown", async () => {
    const ctx = p2Context();
    ctx.data.assets.findByScope = async () => null;
    await expect(
      new P2Adapter().handle(
        match(
          { method: "GET", pattern: "/plugins/:filename", handlerId: "downloadBundle" },
          { filename: "missing.jar" },
          "/plugins/missing.jar",
        ),
        new Request("https://registry.test/plugins/missing.jar"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("GET /plugins/<file> with an invalid filename throws NAME_INVALID", async () => {
    const ctx = p2Context();
    await expect(
      new P2Adapter().handle(
        match(
          { method: "GET", pattern: "/plugins/:filename", handlerId: "downloadBundle" },
          { filename: "not-a-jar.txt" },
          "/plugins/not-a-jar.txt",
        ),
        new Request("https://registry.test/plugins/not-a-jar.txt"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });
});
