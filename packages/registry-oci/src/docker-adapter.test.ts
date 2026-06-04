import { describe, expect, test } from "bun:test";
import type {
  RegistryOciManifestRow,
  RegistryPackageRow,
  RegistryRequestContext,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { DockerAdapter } from "./docker-adapter";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REFERRER_DIGEST = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const OTHER_REFERRER_DIGEST =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const REFERRER_ARTIFACT_TYPE = "application/vnd.hootifactory.test.referrer";
const RAW_MANIFEST = JSON.stringify({ schemaVersion: 2 });

const ctx = {
  repo: { mountPath: "v2/acme/containers" },
  baseUrl: "https://registry.test",
} as RegistryRequestContext;

const match = {
  entry: { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  params: { name: "team/api", reference: "latest" },
  path: "/team/api/manifests/latest",
} satisfies RouteMatch;

const digestMatch = {
  entry: { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  params: { name: "team/api", reference: DIGEST },
  path: `/team/api/manifests/${DIGEST}`,
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "team/api",
  namespace: null,
  metadata: {},
  latestVersion: "latest",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function manifestRow(): RegistryOciManifestRow {
  return {
    id: "manifest_1",
    repositoryId: "repo_1",
    digest: DIGEST,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: null,
    subjectDigest: null,
    raw: RAW_MANIFEST,
    sizeBytes: RAW_MANIFEST.length,
    configDigest: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function referrerRow(digest: string): RegistryOciManifestRow {
  const raw = JSON.stringify({
    schemaVersion: 2,
    artifactType: REFERRER_ARTIFACT_TYPE,
  });
  return {
    id: `manifest_${digest.slice(7, 15)}`,
    repositoryId: "repo_1",
    digest,
    mediaType: "application/vnd.oci.artifact.manifest.v1+json",
    artifactType: REFERRER_ARTIFACT_TYPE,
    subjectDigest: DIGEST,
    raw,
    sizeBytes: raw.length,
    configDigest: null,
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
  };
}

describe("Docker adapter contract", () => {
  test("declares the distribution routes clients depend on", () => {
    const handlers = new DockerAdapter().routes().map((route) => route.handlerId);

    expect(handlers).toContain("tagsList");
    expect(handlers).toContain("putManifest");
    expect(handlers).toContain("startUpload");
    expect(handlers).toContain("patchUpload");
    expect(handlers).toContain("getBlob");
    expect(handlers).toContain("deleteBlob");
  });

  test("maps HTTP methods to registry permissions and bearer challenges", () => {
    const adapter = new DockerAdapter();

    expect(adapter.requiredPermission("GET", match, ctx)).toEqual({
      action: "read",
      repositoryName: "acme/containers/team/api",
      resource: { type: "artifact", packageName: "team/api", artifactRef: "latest" },
    });
    expect(adapter.requiredPermission("PUT", match, ctx).action).toBe("write");
    expect(adapter.requiredPermission("DELETE", match, ctx).action).toBe("delete");
    expect(
      adapter.authChallenge({ action: "write", repositoryName: "acme/containers/team/api" }, ctx),
    ).toEqual({
      header:
        'Bearer realm="https://registry.test/token",service="hootifactory",scope="repository:acme/containers/team/api:push,pull"',
      status: 401,
    });
  });

  test("validates matched route params and query values before stateful work", async () => {
    const adapter = new DockerAdapter();

    await expect(
      adapter.handle(
        {
          entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
          params: { name: "../bad" },
          path: "/../bad/tags/list",
        },
        new Request("https://registry.test/v2/acme/containers/../bad/tags/list"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });

    await expect(
      adapter.handle(
        {
          entry: { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
          params: { name: "team/api" },
          path: "/team/api/blobs/uploads",
        },
        new Request(
          "https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=sha256:bad",
          { method: "POST" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
  });

  test("passes tag cursor pagination to the data service", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, format: "docker", mountPath: "v2/acme/containers" };
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.oci.listTags = async (inputPkg, opts) => {
      expect(inputPkg.id).toBe(pkg.id);
      expect(opts).toEqual({ last: "latest", pageSize: 1 });
      return { tags: ["v1"], truncated: true };
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
        params: { name: pkg.name },
        path: "/team/api/tags/list",
      },
      new Request("https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=latest"),
      ctx,
    );

    expect(response.headers.get("link")).toBe(
      '<https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=v1>; rel="next"',
    );
    await expect(response.json()).resolves.toEqual({
      name: "acme/containers/team/api",
      tags: ["v1"],
    });
  });

  test("filters referrers through one package-scoped batch lookup", async () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.test" });
    ctx.repo = { ...ctx.repo, format: "docker", mountPath: "v2/acme/containers" };
    let packageLookups = 0;
    let subjectLookups = 0;
    let batchLookups = 0;
    ctx.data.packages.findByName = async (name) => {
      packageLookups += 1;
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.oci.listSubjectManifests = async (subjectDigest) => {
      subjectLookups += 1;
      expect(subjectDigest).toBe(DIGEST);
      return [referrerRow(REFERRER_DIGEST), referrerRow(OTHER_REFERRER_DIGEST)];
    };
    ctx.data.oci.listExistingManifestDigests = async (input) => {
      batchLookups += 1;
      expect(input.package.id).toBe(pkg.id);
      expect(input.digests).toEqual([REFERRER_DIGEST, OTHER_REFERRER_DIGEST]);
      return [REFERRER_DIGEST];
    };
    ctx.data.oci.resolveManifest = async () => {
      throw new Error("referrers should not resolve manifests one at a time");
    };

    const response = await new DockerAdapter().handle(
      {
        entry: { method: "GET", pattern: "/:name+/referrers/:digest", handlerId: "referrers" },
        params: { name: pkg.name, digest: DIGEST },
        path: `/team/api/referrers/${DIGEST}`,
      },
      new Request(
        `https://registry.test/v2/acme/containers/team/api/referrers/${DIGEST}?artifactType=${encodeURIComponent(
          REFERRER_ARTIFACT_TYPE,
        )}`,
      ),
      ctx,
    );

    expect(packageLookups).toBe(1);
    expect(subjectLookups).toBe(1);
    expect(batchLookups).toBe(1);
    expect(response.headers.get("oci-filters-applied")).toBe("artifactType");
    const body = (await response.json()) as {
      manifests: Array<{ digest: string; artifactType?: string }>;
    };
    expect(body.manifests.map(({ digest, artifactType }) => ({ digest, artifactType }))).toEqual([
      { digest: REFERRER_DIGEST, artifactType: REFERRER_ARTIFACT_TYPE },
    ]);
  });

  test("digest-pinned manifests emit immutable validators and honor If-None-Match", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, format: "docker", mountPath: "v2/acme/containers" };
    let blockChecks = 0;
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.oci.resolveManifest = async (input) => {
      expect(input.package.id).toBe(pkg.id);
      expect(input.reference).toBe(DIGEST);
      return manifestRow();
    };
    ctx.data.content.isArtifactBlocked = async (digest) => {
      blockChecks += 1;
      expect(digest).toBe(DIGEST);
      return false;
    };

    const adapter = new DockerAdapter();
    const first = await adapter.handle(
      digestMatch,
      new Request(`https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`),
      ctx,
    );
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBe(`"${DIGEST}"`);
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(first.headers.get("docker-content-digest")).toBe(DIGEST);
    await expect(first.text()).resolves.toBe(RAW_MANIFEST);

    const cached = await adapter.handle(
      digestMatch,
      new Request(`https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`, {
        headers: { "if-none-match": etag ?? "" },
      }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(`"${DIGEST}"`);
    expect(cached.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(cached.headers.get("content-length")).toBeNull();
    await expect(cached.text()).resolves.toBe("");
    expect(blockChecks).toBe(2);
  });
});
