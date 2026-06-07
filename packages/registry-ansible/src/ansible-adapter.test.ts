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
import { AnsibleAdapter } from "./ansible-adapter";
import type { AnsibleUploadPlan } from "./ansible-publish";
import { buildAnsibleVersionMetadata } from "./ansible-publish-lifecycle";
import type { AnsibleVersionMeta } from "./ansible-validation";
import { buildCollectionArchive, SAMPLE_MANIFEST } from "./ansible-validation.test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

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
    packageId: "pkg_acme.tools",
    version,
    metadata,
    sizeBytes: 100,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const plan: AnsibleUploadPlan = {
  namespace: "acme",
  name: "tools",
  version: "1.2.3",
  fqcn: "acme.tools",
  manifest: SAMPLE_MANIFEST,
  archiveBytes: new Uint8Array(100),
  scope: "acme.tools@1.2.3",
  declaredSha256: null,
};

const storedMeta: AnsibleVersionMeta = buildAnsibleVersionMetadata(plan, DIGEST);

function ansibleContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "ansible", mountPath: "ansible/private" };
  return ctx;
}

function match(
  pattern: string,
  handlerId: string,
  params: Record<string, string>,
  path: string,
  method: "GET" | "POST" = "GET",
): RouteMatch {
  return { entry: { method, pattern, handlerId }, params, path };
}

/**
 * Build a multipart/form-data body with a `file` field and, when `sha256` is
 * supplied, the client-declared `sha256` field `ansible-galaxy` sends alongside.
 */
function multipartFile(
  boundary: string,
  filename: string,
  data: Uint8Array,
  sha256?: string,
): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const head = enc(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`,
  );
  const sha = sha256
    ? enc(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n${sha256}`)
    : new Uint8Array(0);
  const tail = enc(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + data.length + sha.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(sha, head.length + data.length);
  out.set(tail, head.length + data.length + sha.length);
  return out;
}

describe("Ansible adapter", () => {
  test("declares discovery, publish, download, and collection routes (literals before catch-alls)", () => {
    expect(new AnsibleAdapter().routes()).toEqual([
      { method: "GET", pattern: "/api/", handlerId: "root" },
      { method: "GET", pattern: "/api/v3/", handlerId: "v3Root" },
      { method: "POST", pattern: "/api/v3/artifacts/collections/", handlerId: "publish" },
      { method: "GET", pattern: "/api/v3/collections/download/:filename", handlerId: "download" },
      {
        method: "GET",
        pattern: "/api/v3/imports/collections/:id/",
        handlerId: "import",
      },
      {
        method: "GET",
        pattern: "/api/v3/collections/:namespace/:name/versions/:version/",
        handlerId: "version",
      },
      {
        method: "GET",
        pattern: "/api/v3/collections/:namespace/:name/versions/",
        handlerId: "versions",
      },
      { method: "GET", pattern: "/api/v3/collections/:namespace/:name/", handlerId: "summary" },
    ]);
  });

  test("uses read for GET, write for POST, and bearer auth", () => {
    const adapter = new AnsibleAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Bearer realm="hootifactory"');
  });

  test("collection permission targets the fqcn package", () => {
    const adapter = new AnsibleAdapter();
    const m = match(
      "/api/v3/collections/:namespace/:name/",
      "summary",
      { namespace: "acme", name: "tools" },
      "/api/v3/collections/acme/tools/",
    );
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "acme.tools" },
    });
  });

  test("download permission targets the artifact ref", () => {
    const adapter = new AnsibleAdapter();
    const m = match(
      "/api/v3/collections/download/:filename",
      "download",
      { filename: "acme-tools-1.2.3.tar.gz" },
      "/api/v3/collections/download/acme-tools-1.2.3.tar.gz",
    );
    expect(adapter.requiredPermission("GET", m)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "acme.tools",
        artifactRef: "acme.tools@1.2.3",
      },
    });
  });

  test("GET /api/ returns the discovery document", async () => {
    const res = await new AnsibleAdapter().handle(
      match("/api/", "root", {}, "/api/"),
      new Request("https://registry.test/api/"),
      ansibleContext(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      current_version: "v3",
      available_versions: { v3: "v3/" },
    });
  });

  test("GET /api/v3/ links the published collections index", async () => {
    const res = await new AnsibleAdapter().handle(
      match("/api/v3/", "v3Root", {}, "/api/v3/"),
      new Request("https://registry.test/api/v3/"),
      ansibleContext(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      published: { collections: { index: "/ansible/private/api/v3/collections/" } },
    });
  });

  test("GET collection summary returns highest_version + is cacheable", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("acme.tools");
      return pkgRow("acme.tools");
    };
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [versionRow(storedMeta)];
    };
    const m = match(
      "/api/v3/collections/:namespace/:name/",
      "summary",
      { namespace: "acme", name: "tools" },
      "/api/v3/collections/acme/tools/",
    );
    const res = await new AnsibleAdapter().handle(
      m,
      new Request("https://registry.test/api/v3/collections/acme/tools/"),
      ctx,
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({
      namespace: "acme",
      name: "tools",
      highest_version: { version: "1.2.3" },
    });

    if (!etag) throw new Error("expected etag");
    const cached = await new AnsibleAdapter().handle(
      m,
      new Request("https://registry.test/api/v3/collections/acme/tools/", {
        headers: { "if-none-match": etag },
      }),
      ctx,
    );
    expect(cached.status).toBe(304);
  });

  test("GET collection summary 404s for an unknown collection", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/",
        "summary",
        { namespace: "acme", name: "missing" },
        "/api/v3/collections/acme/missing/",
      ),
      new Request("https://registry.test/api/v3/collections/acme/missing/"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ errors: [{ code: "not_found" }] });
  });

  test("GET version list paginates with limit/offset", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.listLive = async () => [
      versionRow({ ...storedMeta, filename: "acme-tools-1.0.0.tar.gz" }, "1.0.0"),
      versionRow(storedMeta, "1.2.3"),
    ];
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/versions/",
        "versions",
        { namespace: "acme", name: "tools" },
        "/api/v3/collections/acme/tools/versions/",
      ),
      new Request("https://registry.test/api/v3/collections/acme/tools/versions/?limit=1&offset=0"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { count: number }; data: { version: string }[] };
    expect(body.meta).toEqual({ count: 2 });
    expect(body.data.map((entry) => entry.version)).toEqual(["1.2.3"]);
  });

  test("GET version list 404s for an unknown collection", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => null;
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/versions/",
        "versions",
        { namespace: "acme", name: "missing" },
        "/api/v3/collections/acme/missing/versions/",
      ),
      new Request("https://registry.test/api/v3/collections/acme/missing/versions/"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET version detail emits artifact.sha256 + download_url", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/versions/:version/",
        "version",
        { namespace: "acme", name: "tools", version: "1.2.3" },
        "/api/v3/collections/acme/tools/versions/1.2.3/",
      ),
      new Request("https://registry.test/api/v3/collections/acme/tools/versions/1.2.3/"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { sha256: string; filename: string };
      download_url: string;
    };
    expect(body.artifact.sha256).toBe(HEX);
    expect(body.artifact.filename).toBe("acme-tools-1.2.3.tar.gz");
    expect(body.download_url).toBe(
      "https://registry.example.test/ansible/private/api/v3/collections/download/acme-tools-1.2.3.tar.gz",
    );
  });

  test("GET version detail 404s for a missing version", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.findLive = async () => null;
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/versions/:version/",
        "version",
        { namespace: "acme", name: "tools", version: "9.9.9" },
        "/api/v3/collections/acme/tools/versions/9.9.9/",
      ),
      new Request("https://registry.test/api/v3/collections/acme/tools/versions/9.9.9/"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET summary with an invalid namespace returns 400", async () => {
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/",
        "summary",
        { namespace: "Bad-NS", name: "tools" },
        "/api/v3/collections/Bad-NS/tools/",
      ),
      new Request("https://registry.test/api/v3/collections/Bad-NS/tools/"),
      ansibleContext(),
    );
    expect(res.status).toBe(400);
  });

  test("download resolves the stored blob digest for the matching filename", async () => {
    const ctx = ansibleContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("collection-bytes", { headers: { "content-type": contentType } });
    };
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/download/:filename",
        "download",
        { filename: "acme-tools-1.2.3.tar.gz" },
        "/api/v3/collections/download/acme-tools-1.2.3.tar.gz",
      ),
      new Request("https://registry.test/api/v3/collections/download/acme-tools-1.2.3.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(await res.text()).toBe("collection-bytes");
  });

  test("download 404s when the requested filename does not match the stored artifact", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.findLive = async () => versionRow(storedMeta);
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/download/:filename",
        "download",
        { filename: "acme-tools-9.9.9.tar.gz" },
        "/api/v3/collections/download/acme-tools-9.9.9.tar.gz",
      ),
      new Request("https://registry.test/api/v3/collections/download/acme-tools-9.9.9.tar.gz"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download with an invalid filename returns 400", async () => {
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/download/:filename",
        "download",
        { filename: "bad.zip" },
        "/api/v3/collections/download/bad.zip",
      ),
      new Request("https://registry.test/api/v3/collections/download/bad.zip"),
      ansibleContext(),
    );
    expect(res.status).toBe(400);
  });

  test("scan.referencedDigests surfaces the stored artifact digest", () => {
    const scan = new AnsibleAdapter().scan;
    expect(scan?.referencedDigests?.({ ...storedMeta })).toEqual([DIGEST]);
    expect(scan?.referencedDigests?.({ version: "1.0.0" })).toEqual([]);
  });

  test("POST publish stores the artifact and returns a 202 task envelope", async () => {
    const ctx = ansibleContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 100,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const archive = buildCollectionArchive(SAMPLE_MANIFEST);
    const body = multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", archive);
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ task: expect.stringContaining("acme.tools-1.2.3") });
    expect(committed.scan).toEqual({
      name: "acme.tools",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      artifactDigest: DIGEST,
      artifactSha256: HEX,
      filename: "acme-tools-1.2.3.tar.gz",
    });
  });

  test("POST publish returns 409 when the version already exists", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.exists = async () => true;
    const archive = buildCollectionArchive(SAMPLE_MANIFEST);
    const body = multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", archive);
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ errors: [{ code: "conflict.collection_exists" }] });
  });

  test("POST publish rejects a missing file field with 400", async () => {
    const ctx = ansibleContext();
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: new TextEncoder().encode("--BOUND--\r\n"),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("POST publish rejects a non-collection archive with 400", async () => {
    const ctx = ansibleContext();
    const body = multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", new Uint8Array([1, 2, 3, 4]));
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("POST publish accepts a matching client sha256 and rejects a mismatch", async () => {
    const archive = buildCollectionArchive(SAMPLE_MANIFEST);
    const goodSha = digestHex(computeDigest(archive));

    const okCtx = ansibleContext();
    let committedMatch = false;
    okCtx.data.packages.findByName = async () => null;
    okCtx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    okCtx.data.versions.exists = async () => false;
    okCtx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 100,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    okCtx.data.versions.commitOrReleaseBlob = async () => {
      committedMatch = true;
      return { versionId: "ver_1" };
    };
    const okRes = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", archive, goodSha),
      }),
      okCtx,
    );
    expect(okRes.status).toBe(202);
    expect(committedMatch).toBe(true);

    // A declared sha256 that disagrees with the bytes is rejected before storage.
    const badCtx = ansibleContext();
    let storedOnMismatch = false;
    badCtx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => {
      storedOnMismatch = true;
      return { digest: DIGEST, size: 100, deduped: false, refCreated: true, blobRefId: "ref_1" };
    };
    const badRes = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", archive, "b".repeat(64)),
      }),
      badCtx,
    );
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toMatchObject({ errors: [{ code: "invalid" }] });
    expect(storedOnMismatch).toBe(false);
  });

  test("POST publish rejects a malformed sha256 field with 400", async () => {
    const archive = buildCollectionArchive(SAMPLE_MANIFEST);
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", archive, "not-a-hex-digest"),
      }),
      ansibleContext(),
    );
    expect(res.status).toBe(400);
  });

  test("POST publish rejects an empty upload with 400", async () => {
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", new Uint8Array(0)),
      }),
      ansibleContext(),
    );
    expect(res.status).toBe(400);
  });

  test("GET import task reports a completed terminal state for a stored version", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("acme.tools");
      return pkgRow("acme.tools");
    };
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(storedMeta);
    };
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/imports/collections/:id/",
        "import",
        { id: "acme.tools-1.2.3" },
        "/api/v3/imports/collections/acme.tools-1.2.3/",
      ),
      new Request("https://registry.test/api/v3/imports/collections/acme.tools-1.2.3/"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      finished_at: string | null;
      error: unknown;
    };
    expect(body.state).toBe("completed");
    expect(body.finished_at).toBeTruthy();
    expect(body.error).toBeNull();
  });

  test("GET import task 404s for an unknown version", async () => {
    const ctx = ansibleContext();
    ctx.data.packages.findByName = async () => pkgRow("acme.tools");
    ctx.data.versions.findLive = async () => null;
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/imports/collections/:id/",
        "import",
        { id: "acme.tools-9.9.9" },
        "/api/v3/imports/collections/acme.tools-9.9.9/",
      ),
      new Request("https://registry.test/api/v3/imports/collections/acme.tools-9.9.9/"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("GET import task rejects a malformed id with 400", async () => {
    const res = await new AnsibleAdapter().handle(
      match(
        "/api/v3/imports/collections/:id/",
        "import",
        { id: "nodash" },
        "/api/v3/imports/collections/nodash/",
      ),
      new Request("https://registry.test/api/v3/imports/collections/nodash/"),
      ansibleContext(),
    );
    expect(res.status).toBe(400);
  });

  test("declares virtualizable but not proxyable (no proxyIngest hook)", () => {
    const adapter = new AnsibleAdapter();
    expect(adapter.capabilities).toMatchObject({ proxyable: false, virtualizable: true });
    expect("proxyIngest" in adapter).toBe(false);
  });

  test("publish output round-trips through version-detail + download + import", async () => {
    // Drive a real publish, capture the committed metadata, then feed it back
    // through the read/download/import handlers to prove a client can resolve and
    // fetch exactly what was just published.
    const archive = buildCollectionArchive(SAMPLE_MANIFEST);
    const archiveSha = digestHex(computeDigest(archive));
    const blobDigest = computeDigest(archive);

    const pubCtx = ansibleContext();
    let captured: Record<string, unknown> | undefined;
    pubCtx.data.packages.findByName = async () => null;
    pubCtx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    pubCtx.data.versions.exists = async () => false;
    pubCtx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: blobDigest,
      size: archive.length,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    pubCtx.data.versions.commitOrReleaseBlob = async (input) => {
      captured = input.metadata;
      return { versionId: "ver_1" };
    };
    const pubRes = await new AnsibleAdapter().handle(
      match(
        "/api/v3/artifacts/collections/",
        "publish",
        {},
        "/api/v3/artifacts/collections/",
        "POST",
      ),
      new Request("https://registry.test/api/v3/artifacts/collections/", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body: multipartFile("BOUND", "acme-tools-1.2.3.tar.gz", archive, archiveSha),
      }),
      pubCtx,
    );
    expect(pubRes.status).toBe(202);
    if (!captured) throw new Error("expected committed metadata");
    expect(captured.artifactSha256).toBe(archiveSha);
    expect(captured.artifactDigest).toBe(blobDigest);

    // Version detail must advertise exactly what publish committed.
    const readCtx = ansibleContext();
    readCtx.data.packages.findByName = async () => pkgRow("acme.tools");
    readCtx.data.versions.findLive = async () => versionRow(captured ?? {});
    const detailRes = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/:namespace/:name/versions/:version/",
        "version",
        { namespace: "acme", name: "tools", version: "1.2.3" },
        "/api/v3/collections/acme/tools/versions/1.2.3/",
      ),
      new Request("https://registry.test/api/v3/collections/acme/tools/versions/1.2.3/"),
      readCtx,
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      artifact: { sha256: string; filename: string; size: number };
      download_url: string;
    };
    expect(detail.artifact.sha256).toBe(archiveSha);
    expect(detail.artifact.filename).toBe("acme-tools-1.2.3.tar.gz");
    expect(detail.artifact.size).toBe(archive.length);
    expect(detail.download_url).toContain("/download/acme-tools-1.2.3.tar.gz");

    // The download route serves the very digest publish stored.
    const dlCtx = ansibleContext();
    let servedDigest: string | undefined;
    dlCtx.data.packages.findByName = async () => pkgRow("acme.tools");
    dlCtx.data.versions.findLive = async () => versionRow(captured ?? {});
    dlCtx.data.content.blobRefExists = async () => true;
    dlCtx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      servedDigest = digest;
      return new Response(archive, { headers: { "content-type": contentType } });
    };
    const dlRes = await new AnsibleAdapter().handle(
      match(
        "/api/v3/collections/download/:filename",
        "download",
        { filename: "acme-tools-1.2.3.tar.gz" },
        "/api/v3/collections/download/acme-tools-1.2.3.tar.gz",
      ),
      new Request("https://registry.test/api/v3/collections/download/acme-tools-1.2.3.tar.gz"),
      dlCtx,
    );
    expect(dlRes.status).toBe(200);
    expect(servedDigest).toBe(blobDigest);
    // The bytes served hash to the advertised sha256 — what the client verifies.
    const servedBytes = new Uint8Array(await dlRes.arrayBuffer());
    expect(digestHex(computeDigest(servedBytes))).toBe(detail.artifact.sha256);

    // And the publish task URL the client polls resolves to a completed import.
    const impCtx = ansibleContext();
    impCtx.data.packages.findByName = async () => pkgRow("acme.tools");
    impCtx.data.versions.findLive = async () => versionRow(captured ?? {});
    const impRes = await new AnsibleAdapter().handle(
      match(
        "/api/v3/imports/collections/:id/",
        "import",
        { id: "acme.tools-1.2.3" },
        "/api/v3/imports/collections/acme.tools-1.2.3/",
      ),
      new Request("https://registry.test/api/v3/imports/collections/acme.tools-1.2.3/"),
      impCtx,
    );
    expect(impRes.status).toBe(200);
    expect(((await impRes.json()) as { state: string }).state).toBe("completed");
  });
});
