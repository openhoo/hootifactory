import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageSummaryRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { computeDigest, digestHex } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { RpmAdapter } from "./rpm-adapter";
import { buildMinimalRpm } from "./rpm-fixtures";
import type { RpmVersionMeta } from "./rpm-validation";

const summary: RegistryPackageSummaryRow = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "hello",
};

const pkg: RegistryPackageRow = {
  ...summary,
  namespace: null,
  metadata: {},
  latestVersion: "0:1.2.3-4.el9.x86_64",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const versionMeta: RpmVersionMeta = {
  rpmDigest: `sha256:${"c".repeat(64)}`,
  file: "hello-1.2.3-4.el9.x86_64.rpm",
  name: "hello",
  ver: "1.2.3",
  rel: "4.el9",
  arch: "x86_64",
  epoch: 0,
  sha256: "c".repeat(64),
  size: 42,
  buildTime: 1_700_000_123,
  summary: "A greeting",
};

function versionRow(metadata: RpmVersionMeta): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: pkg.id,
    version: "0:1.2.3-4.el9.x86_64",
    metadata,
    sizeBytes: metadata.size,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  };
}

function rpmCtx() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "rpm", mountPath: "rpm/private" };
  return ctx;
}

describe("RPM adapter", () => {
  test("declares repodata, download, and publish routes", () => {
    expect(new RpmAdapter().routes()).toEqual([
      { method: "GET", pattern: "/repodata/repomd.xml", handlerId: "repomd" },
      { method: "GET", pattern: "/repodata/primary.xml.gz", handlerId: "primary" },
      { method: "GET", pattern: "/packages/:file", handlerId: "download" },
      { method: "PUT", pattern: "/packages/:file", handlerId: "publish" },
      { method: "POST", pattern: "/packages/:file", handlerId: "publish" },
      { method: "POST", pattern: "/", handlerId: "publishRoot" },
    ]);
  });

  test("uses read permissions for reads and write permissions for mutations", () => {
    const adapter = new RpmAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    const match = {
      entry: { method: "PUT", pattern: "/packages/:file", handlerId: "publish" },
      params: { file: "hello-1.2.3-4.el9.x86_64.rpm" },
      path: "/packages/hello-1.2.3-4.el9.x86_64.rpm",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("PUT", match)).toEqual({
      action: "write",
      resource: { type: "artifact", artifactRef: "hello-1.2.3-4.el9.x86_64.rpm" },
    });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("repomd checksum matches the bytes served by primary.xml.gz", async () => {
    const ctx = rpmCtx();
    ctx.data.packages.list = async () => [summary];
    ctx.data.versions.listLiveForPackages = async (pkgs, opts) => {
      expect(pkgs[0]?.id).toBe(summary.id);
      expect(opts).toEqual({ orderByCreated: "asc" });
      return new Map([[summary.id, [versionRow(versionMeta)]]]);
    };

    const repomdMatch = {
      entry: { method: "GET", pattern: "/repodata/repomd.xml", handlerId: "repomd" },
      params: {},
      path: "/repodata/repomd.xml",
    } satisfies RouteMatch;
    const primaryMatch = {
      entry: { method: "GET", pattern: "/repodata/primary.xml.gz", handlerId: "primary" },
      params: {},
      path: "/repodata/primary.xml.gz",
    } satisfies RouteMatch;

    const adapter = new RpmAdapter();
    const repomdRes = await adapter.handle(
      repomdMatch,
      new Request("https://registry.test/repodata/repomd.xml"),
      ctx,
    );
    expect(repomdRes.headers.get("content-type")).toContain("application/xml");
    const repomd = await repomdRes.text();

    const primaryRes = await adapter.handle(
      primaryMatch,
      new Request("https://registry.test/repodata/primary.xml.gz"),
      ctx,
    );
    const gzBytes = new Uint8Array(await primaryRes.arrayBuffer());
    const gzHash = digestHex(computeDigest(gzBytes));

    expect(repomd).toContain(`<checksum type="sha256">${gzHash}</checksum>`);
    expect(repomd).toContain('<location href="repodata/primary.xml.gz"/>');
    // The primary itself references the package download path.
    const primaryXml = new TextDecoder().decode(Bun.gunzipSync(gzBytes));
    expect(primaryXml).toContain('<location href="packages/hello-1.2.3-4.el9.x86_64.rpm"/>');
    expect(primaryXml).toContain('<time file="1700000123" build="1700000123"/>');
    expect(repomd).toContain("<revision>1700000123</revision>");
  });

  test("download resolves the stored digest via the rpm_package asset", async () => {
    const ctx = rpmCtx();
    let askedScope = "";
    ctx.data.assets.findByScope = async ({ role, scope }) => {
      expect(role).toBe("rpm_package");
      askedScope = scope;
      return {
        id: "asset_1",
        orgId: "org_1",
        repositoryId: "repo_1",
        packageId: pkg.id,
        packageVersionId: "ver_1",
        blobRefId: "ref_1",
        digest: versionMeta.rpmDigest,
        role: "rpm_package",
        scope,
        path: scope,
        mediaType: "application/x-rpm",
        sizeBytes: versionMeta.size,
        metadata: {},
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    };
    ctx.data.content.blobRefExists = async ({ digest }) => {
      expect(digest).toBe(versionMeta.rpmDigest);
      return true;
    };

    const match = {
      entry: { method: "GET", pattern: "/packages/:file", handlerId: "download" },
      params: { file: "hello-1.2.3-4.el9.x86_64.rpm" },
      path: "/packages/hello-1.2.3-4.el9.x86_64.rpm",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/packages/hello-1.2.3-4.el9.x86_64.rpm"),
      ctx,
    );
    expect(askedScope).toBe("hello-1.2.3-4.el9.x86_64.rpm");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`blob:${versionMeta.rpmDigest}`);
  });

  test("download throws not-found when no asset is found", async () => {
    const ctx = rpmCtx();
    const match = {
      entry: { method: "GET", pattern: "/packages/:file", handlerId: "download" },
      params: { file: "absent-1-1.x86_64.rpm" },
      path: "/packages/absent-1-1.x86_64.rpm",
    } satisfies RouteMatch;
    // The runtime renders thrown registry errors per errorResponseKind; here we
    // assert the handler surfaces a 404-status RegistryError.
    await expect(
      new RpmAdapter().handle(
        match,
        new Request("https://registry.test/packages/absent-1-1.x86_64.rpm"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("publish stores the rpm and commits a version derived from its header", async () => {
    const ctx = rpmCtx();
    const rpm = buildMinimalRpm({
      name: "hello",
      version: "1.2.3",
      release: "4.el9",
      arch: "x86_64",
      epoch: 0,
      buildTime: 1_700_000_456,
      summary: "A greeting",
    });
    const expectedDigest = computeDigest(rpm);

    let createdPkg = false;
    ctx.data.packages.findOrCreate = async (input) => {
      expect(input.name).toBe("hello");
      createdPkg = true;
      return pkg;
    };
    ctx.data.versions.find = async () => null; // no conflict
    let storedData: Uint8Array | null = null;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      storedData = input.data;
      expect(input.scope).toBe("hello-1.2.3-4.el9.x86_64.rpm");
      return {
        digest: expectedDigest,
        size: input.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    let committedMeta: Record<string, unknown> | null = null;
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committedMeta = input.metadata;
      expect(input.version).toBe("0:1.2.3-4.el9.x86_64");
      return { versionId: "ver_1" };
    };

    const match = {
      entry: { method: "PUT", pattern: "/packages/:file", handlerId: "publish" },
      params: { file: "hello-1.2.3-4.el9.x86_64.rpm" },
      path: "/packages/hello-1.2.3-4.el9.x86_64.rpm",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/packages/hello-1.2.3-4.el9.x86_64.rpm", {
        method: "PUT",
        body: rpm,
      }),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(createdPkg).toBe(true);
    expect(storedData).not.toBeNull();
    expect(committedMeta).toMatchObject({
      name: "hello",
      ver: "1.2.3",
      rel: "4.el9",
      arch: "x86_64",
      epoch: 0,
      buildTime: 1_700_000_456,
      rpmDigest: expectedDigest,
      sha256: digestHex(expectedDigest),
      file: "hello-1.2.3-4.el9.x86_64.rpm",
    });
  });

  test("publish returns 409 when the version already exists", async () => {
    const ctx = rpmCtx();
    const rpm = buildMinimalRpm({
      name: "hello",
      version: "1.2.3",
      release: "4.el9",
      arch: "x86_64",
    });
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.versions.find = async () => versionRow(versionMeta); // conflict

    const match = {
      entry: { method: "PUT", pattern: "/packages/:file", handlerId: "publish" },
      params: { file: "hello-1.2.3-4.el9.x86_64.rpm" },
      path: "/packages/hello-1.2.3-4.el9.x86_64.rpm",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/packages/hello-1.2.3-4.el9.x86_64.rpm", {
        method: "PUT",
        body: rpm,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
  });

  test("publish via multipart skips a leading text field and stores the rpm bytes", async () => {
    const ctx = rpmCtx();
    const rpm = buildMinimalRpm({
      name: "hello",
      version: "1.2.3",
      release: "4.el9",
      arch: "x86_64",
    });
    const expectedDigest = computeDigest(rpm);
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.versions.find = async () => null;
    let storedData: Uint8Array | null = null;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      storedData = input.data;
      return {
        digest: computeDigest(input.data),
        size: input.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });

    const boundary = "----rpmtest";
    const enc = new TextEncoder();
    const metaField = enc.encode(
      `--${boundary}\r\ncontent-disposition: form-data; name="meta"\r\n\r\nsomevalue\r\n`,
    );
    const fileHead = enc.encode(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="hello-1.2.3-4.el9.x86_64.rpm"\r\n\r\n`,
    );
    const fileTail = enc.encode(`\r\n--${boundary}--\r\n`);
    const multipartBody = new Uint8Array([...metaField, ...fileHead, ...rpm, ...fileTail]);

    const match = {
      entry: { method: "POST", pattern: "/", handlerId: "publishRoot" },
      params: {},
      path: "/",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
      }),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(storedData).not.toBeNull();
    // The stored bytes are the .rpm, NOT the leading "somevalue" text field.
    expect(Buffer.from(storedData as unknown as Uint8Array).equals(Buffer.from(rpm))).toBe(true);
    expect(computeDigest(storedData as unknown as Uint8Array)).toBe(expectedDigest);
  });

  test("publish via root multipart derives identity from the uploaded filename fallback", async () => {
    const ctx = rpmCtx();
    const rpm = buildMinimalRpm({});
    ctx.data.packages.findOrCreate = async ({ name }) => {
      expect(name).toBe("hello");
      return pkg;
    };
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => ({
      digest: computeDigest(input.data),
      size: input.data.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    let committedVersion: string | undefined;
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committedVersion = input.version;
      return { versionId: "ver_1" };
    };

    const boundary = "----rpmfallback";
    const enc = new TextEncoder();
    const fileHead = enc.encode(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="hello-1.2.3-4.el9.x86_64.rpm"\r\n\r\n`,
    );
    const fileTail = enc.encode(`\r\n--${boundary}--\r\n`);
    const multipartBody = new Uint8Array([...fileHead, ...rpm, ...fileTail]);

    const res = await new RpmAdapter().handle(
      {
        entry: { method: "POST", pattern: "/", handlerId: "publishRoot" },
        params: {},
        path: "/",
      },
      new Request("https://registry.test/", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
      }),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(committedVersion).toBe("0:1.2.3-4.el9.x86_64");
  });

  test("publish via POST /packages/:file stores the rpm", async () => {
    const ctx = rpmCtx();
    const rpm = buildMinimalRpm({
      name: "hello",
      version: "1.2.3",
      release: "4.el9",
      arch: "x86_64",
    });
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.versions.find = async () => null;
    let stored = false;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      stored = true;
      return {
        digest: computeDigest(input.data),
        size: input.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async () => ({ versionId: "ver_1" });

    const match = {
      entry: { method: "POST", pattern: "/packages/:file", handlerId: "publish" },
      params: { file: "hello-1.2.3-4.el9.x86_64.rpm" },
      path: "/packages/hello-1.2.3-4.el9.x86_64.rpm",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/packages/hello-1.2.3-4.el9.x86_64.rpm", {
        method: "POST",
        body: rpm,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(stored).toBe(true);
  });

  test("publish with an empty body returns 400", async () => {
    const ctx = rpmCtx();
    const match = {
      entry: { method: "PUT", pattern: "/packages/:file", handlerId: "publish" },
      params: { file: "hello-1.2.3-4.el9.x86_64.rpm" },
      path: "/packages/hello-1.2.3-4.el9.x86_64.rpm",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/packages/hello-1.2.3-4.el9.x86_64.rpm", {
        method: "PUT",
        body: new Uint8Array(0),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "empty package" });
  });

  test("download rejects a path-traversing filename with 404", async () => {
    const ctx = rpmCtx();
    // RpmFileSchema must reject this before any data lookup happens.
    ctx.data.assets.findByScope = async () => {
      throw new Error("should not reach the data layer for an invalid filename");
    };
    const match = {
      entry: { method: "GET", pattern: "/packages/:file", handlerId: "download" },
      params: { file: "../../etc/passwd" },
      path: "/packages/../../etc/passwd",
    } satisfies RouteMatch;
    await expect(
      new RpmAdapter().handle(
        match,
        new Request("https://registry.test/packages/..%2f..%2fetc%2fpasswd"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("primary.xml.gz returns 304 when the etag matches If-None-Match", async () => {
    const ctx = rpmCtx();
    ctx.data.packages.list = async () => [summary];
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([[summary.id, [versionRow(versionMeta)]]]);

    const adapter = new RpmAdapter();
    const primaryMatch = {
      entry: { method: "GET", pattern: "/repodata/primary.xml.gz", handlerId: "primary" },
      params: {},
      path: "/repodata/primary.xml.gz",
    } satisfies RouteMatch;
    const first = await adapter.handle(
      primaryMatch,
      new Request("https://registry.test/repodata/primary.xml.gz"),
      ctx,
    );
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const second = await adapter.handle(
      primaryMatch,
      new Request("https://registry.test/repodata/primary.xml.gz", {
        headers: { "if-none-match": etag as string },
      }),
      ctx,
    );
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  test("publish derives identity from the filename when header tags are absent", async () => {
    const ctx = rpmCtx();
    // A buffer that is not a parseable RPM header -> all tags fall back to filename.
    const notAnRpm = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    ctx.data.packages.findOrCreate = async (input) => {
      expect(input.name).toBe("mypkg");
      return { ...pkg, name: "mypkg" };
    };
    ctx.data.versions.find = async () => null;
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => ({
      digest: computeDigest(input.data),
      size: input.data.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    let version = "";
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      version = input.version;
      return { versionId: "ver_1" };
    };

    const match = {
      entry: { method: "PUT", pattern: "/packages/:file", handlerId: "publish" },
      params: { file: "mypkg-2.0-3.noarch.rpm" },
      path: "/packages/mypkg-2.0-3.noarch.rpm",
    } satisfies RouteMatch;
    const res = await new RpmAdapter().handle(
      match,
      new Request("https://registry.test/packages/mypkg-2.0-3.noarch.rpm", {
        method: "PUT",
        body: notAnRpm,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(version).toBe("0:2.0-3.noarch");
  });
});
