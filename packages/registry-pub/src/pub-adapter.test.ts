import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { PubAdapter } from "./pub-adapter";
import { concat, tarEntry } from "./pub-tarball.test";
import type { PubVersionMeta } from "./pub-validation";

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "demo",
  namespace: null,
  metadata: {},
  latestVersion: "1.2.3",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function meta(version: string): PubVersionMeta {
  return {
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSha256: "c".repeat(64),
    pubspec: { name: "demo", version },
    published: "2026-01-02T00:00:00.000Z",
  };
}

function versionRow(version: string, metadata: PubVersionMeta): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: pkg.id,
    version,
    metadata,
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function pubArchive(name: string, version: string): Uint8Array {
  const tar = concat(
    tarEntry("pubspec.yaml", `name: ${name}\nversion: ${version}\n`),
    new Uint8Array(1024),
  );
  return Bun.gzipSync(tar);
}

function uploadRequest(archive: Uint8Array): Request {
  const form = new FormData();
  form.append("file", new File([archive], "package.tar.gz"), "package.tar.gz");
  return new Request("https://registry.test/pub/private/api/packages/versions/newUpload", {
    method: "POST",
    body: form,
  });
}

const listingMatch = {
  entry: { method: "GET", pattern: "/api/packages/:package", handlerId: "listing" },
  params: { package: "demo" },
  path: "/api/packages/demo",
} satisfies RouteMatch;

const versionMatch = {
  entry: {
    method: "GET",
    pattern: "/api/packages/:package/versions/:version",
    handlerId: "version",
  },
  params: { package: "demo", version: "1.2.3" },
  path: "/api/packages/demo/versions/1.2.3",
} satisfies RouteMatch;

const downloadMatch = {
  entry: { method: "GET", pattern: "/api/archives/:file", handlerId: "download" },
  params: { file: "demo-1.2.3.tar.gz" },
  path: "/api/archives/demo-1.2.3.tar.gz",
} satisfies RouteMatch;

const uploadMatch = {
  entry: {
    method: "POST",
    pattern: "/api/packages/versions/newUpload",
    handlerId: "publishUpload",
  },
  params: {},
  path: "/api/packages/versions/newUpload",
} satisfies RouteMatch;

function testContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "pub", mountPath: "pub/private" };
  return ctx;
}

describe("Pub adapter", () => {
  test("declares the pub repository routes in matcher order", () => {
    expect(new PubAdapter().routes()).toEqual([
      { method: "GET", pattern: "/api/packages/versions/new", handlerId: "publishNew" },
      { method: "POST", pattern: "/api/packages/versions/newUpload", handlerId: "publishUpload" },
      {
        method: "GET",
        pattern: "/api/packages/versions/newUploadFinish",
        handlerId: "publishFinish",
      },
      {
        method: "GET",
        pattern: "/api/packages/:package/versions/:version",
        handlerId: "version",
      },
      { method: "GET", pattern: "/api/packages/:package", handlerId: "listing" },
      { method: "GET", pattern: "/api/archives/:file", handlerId: "download" },
    ]);
  });

  test("emits a Bearer challenge and read/write permissions", () => {
    const adapter = new PubAdapter();
    expect(adapter.authChallenge().header).toBe('Bearer realm="hootifactory"');
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    expect(
      adapter.requiredPermission("GET", {
        ...downloadMatch,
      }),
    ).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "demo",
        artifactRef: "demo@1.2.3",
      },
    });
    expect(adapter.requiredPermission("GET", { ...listingMatch })).toEqual({
      action: "read",
      resource: { type: "package", packageName: "demo" },
    });
  });

  test("listing serves the pub version-list envelope with archive_url + latest", async () => {
    const ctx = testContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkg;
    };
    ctx.data.versions.listLive = async (row, opts) => {
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [versionRow("1.0.0", meta("1.0.0")), versionRow("1.2.3", meta("1.2.3"))];
    };

    const res = await new PubAdapter().handle(
      listingMatch,
      new Request("https://registry.test/pub/private/api/packages/demo"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    const body = (await res.json()) as {
      name: string;
      latest: { version: string; archive_url: string; archive_sha256: string; pubspec: unknown };
      versions: { version: string }[];
    };
    expect(body.name).toBe("demo");
    expect(body.latest.version).toBe("1.2.3");
    expect(body.versions.map((v) => v.version)).toEqual(["1.0.0", "1.2.3"]);
    expect(body.latest.archive_url).toBe(
      "https://registry.example.test/pub/private/api/archives/demo-1.2.3.tar.gz",
    );
    expect(body.latest.archive_sha256).toBe("c".repeat(64));
    expect(body.latest.pubspec).toEqual({ name: "demo", version: "1.2.3" });

    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    const cached = await new PubAdapter().handle(
      listingMatch,
      new Request("https://registry.test/pub/private/api/packages/demo", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("listing renders the pub error envelope for an unknown package", async () => {
    const ctx = testContext();
    // findByName defaults to null in the test context → no versions → not found.
    const res = await new PubAdapter().handle(
      listingMatch,
      new Request("https://registry.test/pub/private/api/packages/demo"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NotFound");
    expect(body.error.message).toContain("demo");
  });

  test("version serves the single-version pub envelope", async () => {
    const ctx = testContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("demo");
      return pkg;
    };
    ctx.data.versions.findLive = async (row, version) => {
      expect(row.id).toBe(pkg.id);
      expect(version).toBe("1.2.3");
      return versionRow("1.2.3", meta("1.2.3"));
    };

    const res = await new PubAdapter().handle(
      versionMatch,
      new Request("https://registry.test/pub/private/api/packages/demo/versions/1.2.3"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    const body = (await res.json()) as {
      version: string;
      archive_url: string;
      archive_sha256: string;
      pubspec: unknown;
    };
    expect(body.version).toBe("1.2.3");
    expect(body.archive_url).toBe(
      "https://registry.example.test/pub/private/api/archives/demo-1.2.3.tar.gz",
    );
    expect(body.archive_sha256).toBe("c".repeat(64));
    expect(body.pubspec).toEqual({ name: "demo", version: "1.2.3" });
  });

  test("version renders the pub error envelope for an unknown version", async () => {
    const ctx = testContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => null;

    const res = await new PubAdapter().handle(
      versionMatch,
      new Request("https://registry.test/pub/private/api/packages/demo/versions/1.2.3"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NotFound");
    expect(body.error.message).toContain("1.2.3");
  });

  test("download resolves the stored archive digest and serves the blob", async () => {
    const ctx = testContext();
    let blobRefArgs: unknown = null;
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async (row, version) => {
      expect(row.id).toBe(pkg.id);
      expect(version).toBe("1.2.3");
      return versionRow("1.2.3", meta("1.2.3"));
    };
    ctx.data.content.blobRefExists = async (input) => {
      blobRefArgs = input;
      return true;
    };

    const res = await new PubAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/pub/private/api/archives/demo-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(blobRefArgs).toMatchObject({
      digest: `sha256:${"a".repeat(64)}`,
      kind: "pub_archive",
      scope: "demo@1.2.3",
    });
    expect(await res.text()).toBe(`blob:sha256:${"a".repeat(64)}`);
  });

  test("publish stores a new version and 303-redirects to the finish endpoint", async () => {
    const ctx = testContext();
    const created: { name?: string; version?: string; metadata?: PubVersionMeta } = {};
    ctx.data.packages.findByName = async () => null;
    ctx.data.versions.exists = async () => false;
    ctx.data.packages.findOrCreate = async (input) => {
      created.name = input.name;
      return { ...pkg, name: input.name };
    };
    ctx.data.content.storeBlobWithRef = async (input) => {
      expect(input.kind).toBe("pub_archive");
      expect(input.scope).toBe("demo@1.2.3");
      return {
        digest: `sha256:${"d".repeat(64)}`,
        size: input.data.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      created.version = input.version;
      created.metadata = input.metadata as PubVersionMeta;
      return { versionId: "ver_new" };
    };

    const res = await new PubAdapter().handle(
      uploadMatch,
      uploadRequest(pubArchive("demo", "1.2.3")),
      ctx,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://registry.example.test/pub/private/api/packages/versions/newUploadFinish",
    );
    expect(created.name).toBe("demo");
    expect(created.version).toBe("1.2.3");
    expect(created.metadata?.archiveDigest).toBe(`sha256:${"d".repeat(64)}`);
    expect(created.metadata?.pubspec).toEqual({ name: "demo", version: "1.2.3" });
  });

  test("publish rejects a duplicate version with the pub error envelope", async () => {
    const ctx = testContext();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.exists = async (_pkg, version) => version === "1.2.3";

    const res = await new PubAdapter().handle(
      uploadMatch,
      uploadRequest(pubArchive("demo", "1.2.3")),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PackageExists");
    expect(typeof body.error.message).toBe("string");
  });

  test("publishNew advertises the absolute upload url", async () => {
    const ctx = testContext();
    const res = await new PubAdapter().handle(
      {
        entry: { method: "GET", pattern: "/api/packages/versions/new", handlerId: "publishNew" },
        params: {},
        path: "/api/packages/versions/new",
      },
      new Request("https://registry.test/pub/private/api/packages/versions/new"),
      ctx,
    );
    const body = await res.json();
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    expect(body).toEqual({
      url: "https://registry.example.test/pub/private/api/packages/versions/newUpload",
      fields: {},
    });
  });

  test("publishFinish returns the pub success envelope", async () => {
    const ctx = testContext();
    const res = await new PubAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/api/packages/versions/newUploadFinish",
          handlerId: "publishFinish",
        },
        params: {},
        path: "/api/packages/versions/newUploadFinish",
      },
      new Request("https://registry.test/pub/private/api/packages/versions/newUploadFinish"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    const body = (await res.json()) as { success: { message: string } };
    expect(typeof body.success.message).toBe("string");
  });

  test("download renders the pub error envelope for a missing archive", async () => {
    const ctx = testContext();
    // findByName defaults to null → no package → archive not found.
    const res = await new PubAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/pub/private/api/archives/demo-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NotFound");
    expect(body.error.message).toContain("demo-1.2.3.tar.gz");
  });
});
