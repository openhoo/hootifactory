import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepo, createRepoReturning, createToken, setupOwner } from "./helpers";

function runOras(args: string[], cwd: string): string {
  return dockerRun(CLI_IMAGES.oras, args, {
    cwd,
    env: { ORAS_CACHE: join(cwd, ".oras-cache") },
  });
}

function digestFrom(output: string): string {
  const digest = output.match(/sha256:[a-f0-9]{64}/)?.[0];
  expect(digest).toBeTruthy();
  return digest!;
}

test.describe("oci registry (Dockerized real ORAS)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("oras push -> pull -> attach -> discover round-trips OCI artifacts", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "artifacts", format: "oci" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "oras" })).json())
      .secret as string;

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-"));
    const pullDir = join(work, "pulled");
    mkdirSync(pullDir);
    writeFileSync(join(work, "payload.txt"), "hello from oras\n");
    writeFileSync(
      join(work, "sbom.json"),
      JSON.stringify({ name: "artifact", packages: ["payload"] }),
    );

    const target = `${host}/${owner.orgSlug}/artifacts/demo:v1`;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];
    const payloadType = "application/vnd.hootifactory.test.payload";
    const artifactType = "application/vnd.hootifactory.test.artifact";
    const sbomType = "application/vnd.hootifactory.test.sbom";

    const push = runOras(
      [
        "push",
        ...auth,
        "--artifact-type",
        artifactType,
        "--format",
        "json",
        target,
        `payload.txt:${payloadType}`,
      ],
      work,
    );
    const subjectDigest = digestFrom(push);

    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/artifacts/demo/tags/list`);
    expect(tags.status()).toBe(200);
    expect((await tags.json()).tags).toContain("v1");

    runOras(["pull", ...auth, "--output", pullDir, target], work);
    expect(readFileSync(join(pullDir, "payload.txt"), "utf8")).toBe("hello from oras\n");

    const attach = runOras(
      [
        "attach",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--artifact-type",
        sbomType,
        "--format",
        "json",
        target,
        `sbom.json:${sbomType}+json`,
      ],
      work,
    );
    const referrerDigest = digestFrom(attach);

    const discover = runOras(
      [
        "discover",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--format",
        "json",
        "--depth",
        "1",
        target,
      ],
      work,
    );
    expect(discover).toContain(referrerDigest);
    expect(discover).toContain(sbomType);

    const head = await owner.ctx.head(`/v2/${owner.orgSlug}/artifacts/demo/manifests/v1`);
    expect(head.status()).toBe(200);
    expect(head.headers()["docker-content-digest"]).toBe(subjectDigest);

    const referrers = await owner.ctx.get(
      `/v2/${owner.orgSlug}/artifacts/demo/referrers/${subjectDigest}`,
    );
    expect(referrers.status()).toBe(200);
    expect(await referrers.json()).toMatchObject({
      manifests: expect.arrayContaining([
        expect.objectContaining({ artifactType: sbomType, digest: referrerDigest }),
      ]),
    });

    expect(existsSync(join(pullDir, "payload.txt"))).toBe(true);
  });
});

/** A unique, slug-safe suffix mirroring the npm spec's timestamp+uuid approach. */
function ociSuffix(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

interface DiscoverNode {
  artifactType?: string;
  digest?: string;
  manifests?: DiscoverNode[];
  referrers?: DiscoverNode[];
}

/**
 * Flatten an `oras discover --format json` document into the list of referrer
 * entries, tolerating either the `manifests` or `referrers` array key.
 */
function discoverReferrers(output: string): DiscoverNode[] {
  const root = JSON.parse(output) as DiscoverNode;
  const out: DiscoverNode[] = [];
  const walk = (node: DiscoverNode) => {
    for (const child of node.manifests ?? node.referrers ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

test.describe("oci registry extended scenarios (Dockerized real ORAS)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("push multiple files with distinct media types and pull them back", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-multifile-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-multi" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-multi-"));
    const pullDir = join(work, "pulled");
    mkdirSync(pullDir);
    const payloadBody = "multi-file payload\n";
    const metaBody = JSON.stringify({ kind: "meta", value: 42 });
    writeFileSync(join(work, "payload.txt"), payloadBody);
    writeFileSync(join(work, "meta.json"), metaBody);

    const name = "bundle";
    const target = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    const payloadType = "application/vnd.hootifactory.test.payload";
    const metaType = "application/vnd.hootifactory.test.meta+json";
    const artifactType = "application/vnd.hootifactory.test.bundle";

    runOras(
      [
        "push",
        ...auth,
        "--artifact-type",
        artifactType,
        "--format",
        "json",
        target,
        `payload.txt:${payloadType}`,
        `meta.json:${metaType}`,
      ],
      work,
    );

    runOras(["pull", ...auth, "--output", pullDir, target], work);
    expect(existsSync(join(pullDir, "payload.txt"))).toBe(true);
    expect(existsSync(join(pullDir, "meta.json"))).toBe(true);
    expect(readFileSync(join(pullDir, "payload.txt"), "utf8")).toBe(payloadBody);
    expect(readFileSync(join(pullDir, "meta.json"), "utf8")).toBe(metaBody);
  });

  test("push with annotations is preserved in the manifest", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-annot-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-annot" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-annot-"));
    writeFileSync(join(work, "payload.txt"), "annotated\n");

    const name = "annotated";
    const target = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    const payloadType = "application/vnd.hootifactory.test.payload";
    const val1 = `value-one-${ociSuffix()}`;
    const val2 = `value-two-${ociSuffix()}`;

    const push = runOras(
      [
        "push",
        ...auth,
        "--annotation",
        `com.hootifactory.key1=${val1}`,
        "--annotation",
        `com.hootifactory.key2=${val2}`,
        "--format",
        "json",
        target,
        `payload.txt:${payloadType}`,
      ],
      work,
    );
    const subjectDigest = digestFrom(push);

    // `oras manifest fetch` rejects --no-tty, so use creds without it.
    const fetchAuth = ["--plain-http", "-u", "__token__", "-p", secret];
    const fetched = runOras(["manifest", "fetch", ...fetchAuth, "--format", "json", target], work);
    expect(fetched).toContain(val1);
    expect(fetched).toContain(val2);

    const manifest = await owner.ctx.get(`/v2/${owner.orgSlug}/${repo}/${name}/manifests/v1`);
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()["docker-content-digest"]).toBe(subjectDigest);
    const manifestJson = await manifest.json();
    expect(manifestJson.annotations["com.hootifactory.key1"]).toBe(val1);
    expect(manifestJson.annotations["com.hootifactory.key2"]).toBe(val2);
  });

  test("oras copy duplicates an artifact between two hosted repos", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repoA = `oci-copy-src-${ociSuffix()}`;
    const repoB = `oci-copy-dst-${ociSuffix()}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoA, format: "oci" })).status(),
    ).toBe(201);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoB, format: "oci" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "oras-copy" })).json())
      .secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-copy-"));
    const pullDir = join(work, "pulled");
    mkdirSync(pullDir);
    const body = "copy me across repos\n";
    writeFileSync(join(work, "payload.txt"), body);

    const name = "img";
    const refA = `${host}/${owner.orgSlug}/${repoA}/${name}:v1`;
    const refB = `${host}/${owner.orgSlug}/${repoB}/${name}:v1`;
    const payloadType = "application/vnd.hootifactory.test.payload";
    const artifactType = "application/vnd.hootifactory.test.copy";

    runOras(
      [
        "push",
        ...auth,
        "--artifact-type",
        artifactType,
        "--format",
        "json",
        refA,
        `payload.txt:${payloadType}`,
      ],
      work,
    );

    runOras(
      [
        "copy",
        "--from-plain-http",
        "--to-plain-http",
        "--no-tty",
        "--from-username",
        "__token__",
        "--from-password",
        secret,
        "--to-username",
        "__token__",
        "--to-password",
        secret,
        refA,
        refB,
      ],
      work,
    );

    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/${repoB}/${name}/tags/list`);
    expect(tags.status()).toBe(200);
    expect((await tags.json()).tags).toContain("v1");

    runOras(["pull", ...auth, "--output", pullDir, refB], work);
    expect(existsSync(join(pullDir, "payload.txt"))).toBe(true);
    expect(readFileSync(join(pullDir, "payload.txt"), "utf8")).toBe(body);
  });

  test("oras tag adds a new tag to an existing manifest", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-tag-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "oras-tag" })).json())
      .secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-tag-"));
    writeFileSync(join(work, "payload.txt"), "tag me\n");

    const name = "img";
    const repoRef = `${host}/${owner.orgSlug}/${repo}/${name}`;
    const v1Ref = `${repoRef}:v1`;
    const payloadType = "application/vnd.hootifactory.test.payload";

    runOras(["push", ...auth, "--format", "json", v1Ref, `payload.txt:${payloadType}`], work);

    // `oras tag` and `oras repo tags` do not accept --no-tty.
    const plainAuth = ["--plain-http", "-u", "__token__", "-p", secret];
    runOras(["tag", ...plainAuth, v1Ref, "v2"], work);

    const listed = runOras(["repo", "tags", ...plainAuth, repoRef], work);
    expect(listed).toContain("v1");
    expect(listed).toContain("v2");

    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/${repo}/${name}/tags/list`);
    expect(tags.status()).toBe(200);
    const tagList = (await tags.json()).tags as string[];
    expect(tagList).toContain("v1");
    expect(tagList).toContain("v2");
  });

  test("multiple referrers attach and are all discovered", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-referrers-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-referrers" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-referrers-"));
    writeFileSync(join(work, "payload.txt"), "subject\n");
    writeFileSync(join(work, "sbom.json"), JSON.stringify({ packages: ["payload"] }));
    writeFileSync(join(work, "sig.bin"), "signature-bytes\n");

    const name = "subject";
    const target = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    const payloadType = "application/vnd.hootifactory.test.payload";
    const sbomType = "application/vnd.hootifactory.test.sbom";
    const sigType = "application/vnd.hootifactory.test.signature";

    const push = runOras(
      ["push", ...auth, "--format", "json", target, `payload.txt:${payloadType}`],
      work,
    );
    const subjectDigest = digestFrom(push);

    const sbomAttach = runOras(
      [
        "attach",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--artifact-type",
        sbomType,
        "--format",
        "json",
        target,
        `sbom.json:${sbomType}+json`,
      ],
      work,
    );
    const sbomDigest = digestFrom(sbomAttach);

    const sigAttach = runOras(
      [
        "attach",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--artifact-type",
        sigType,
        "--format",
        "json",
        target,
        `sig.bin:${sigType}`,
      ],
      work,
    );
    const sigDigest = digestFrom(sigAttach);

    const discover = runOras(
      [
        "discover",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--format",
        "json",
        target,
      ],
      work,
    );
    const referrers = discoverReferrers(discover);
    expect(referrers.length).toBeGreaterThanOrEqual(2);
    const artifactTypes = referrers.map((r) => r.artifactType);
    expect(artifactTypes).toContain(sbomType);
    expect(artifactTypes).toContain(sigType);

    const apiReferrers = await owner.ctx.get(
      `/v2/${owner.orgSlug}/${repo}/${name}/referrers/${subjectDigest}`,
    );
    expect(apiReferrers.status()).toBe(200);
    const manifests = (await apiReferrers.json()).manifests as {
      artifactType: string;
      digest: string;
    }[];
    expect(manifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactType: sbomType, digest: sbomDigest }),
        expect.objectContaining({ artifactType: sigType, digest: sigDigest }),
      ]),
    );
  });

  // NOTE: OCI/Docker/Helm virtual repositories are NOT exercised for manifest
  // *reads* via the real CLI. Unlike npm/pypi/nuget/go (which the suite covers
  // for virtual aggregation), the OCI bearer token a client obtains is scoped to
  // the virtual repo's image path, and per-member re-authorization
  // (authorizeVirtualMember) rejects it, so a pull through a virtual OCI repo
  // resolves to "not found". We still assert the defined read-only contract:
  // writes to a virtual repo are rejected at dispatch.
  test("writes are rejected on a virtual repository", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const virtualName = `oci-virtual-${ociSuffix()}`;
    await createRepoReturning(owner.ctx, owner.orgId, {
      name: virtualName,
      format: "oci",
      kind: "virtual",
    });
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-virtual" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-virtual-"));
    writeFileSync(join(work, "payload.txt"), "served via virtual repo\n");

    const payloadType = "application/vnd.hootifactory.test.payload";
    const virtualRef = `${host}/${owner.orgSlug}/${virtualName}/img:v1`;

    let writeRejected = false;
    try {
      runOras(
        ["push", ...auth, "--format", "json", virtualRef, `payload.txt:${payloadType}`],
        work,
      );
    } catch {
      writeRejected = true;
    }
    expect(writeRejected).toBe(true);
  });
});

test.describe("oci registry error and edge scenarios (Dockerized real ORAS)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("pulling a nonexistent tag fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-missing-tag-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-missing-tag" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-missing-tag-"));
    const pullDir = join(work, "pulled");
    mkdirSync(pullDir);
    writeFileSync(join(work, "payload.txt"), "present\n");

    const name = "img";
    const payloadType = "application/vnd.hootifactory.test.payload";
    const v1Ref = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    runOras(["push", ...auth, "--format", "json", v1Ref, `payload.txt:${payloadType}`], work);

    const v2Ref = `${host}/${owner.orgSlug}/${repo}/${name}:v2`;
    let failed = false;
    let message = "";
    try {
      runOras(["pull", ...auth, "--output", pullDir, v2Ref], work);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unauthorized|denied|401|403|404/i);
  });

  test("discover on a subject with no referrers returns an empty set", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-no-referrers-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-no-referrers" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-no-referrers-"));
    writeFileSync(join(work, "payload.txt"), "lonely subject\n");

    const name = "img";
    const payloadType = "application/vnd.hootifactory.test.payload";
    const target = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    const push = runOras(
      ["push", ...auth, "--format", "json", target, `payload.txt:${payloadType}`],
      work,
    );
    const subjectDigest = digestFrom(push);

    // `oras discover` does not accept --no-tty; use plain creds.
    const plainAuth = ["--plain-http", "-u", "__token__", "-p", secret];
    const discover = runOras(
      [
        "discover",
        ...plainAuth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--format",
        "json",
        target,
      ],
      work,
    );
    expect(discoverReferrers(discover)).toHaveLength(0);

    const apiReferrers = await owner.ctx.get(
      `/v2/${owner.orgSlug}/${repo}/${name}/referrers/${subjectDigest}`,
    );
    expect(apiReferrers.status()).toBe(200);
    expect((await apiReferrers.json()).manifests).toEqual([]);
  });

  test("pull with an invalid token is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-bad-token-${ociSuffix()}`;
    // Private repo is the default (no visibility specified).
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-bad-token" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-bad-token-"));
    const pullDir = join(work, "pulled");
    mkdirSync(pullDir);
    writeFileSync(join(work, "payload.txt"), "secret payload\n");

    const name = "img";
    const payloadType = "application/vnd.hootifactory.test.payload";
    const target = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    runOras(["push", ...auth, "--format", "json", target, `payload.txt:${payloadType}`], work);

    const badAuth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", "wrong-token"];
    let failed = false;
    let message = "";
    try {
      runOras(["pull", ...badAuth, "--output", pullDir, target], work);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/unauthorized|denied|401|403/i);
  });

  test("manifest fetch of a nonexistent tag fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = `oci-missing-manifest-${ociSuffix()}`;
    expect((await createRepo(owner.ctx, owner.orgId, { name: repo, format: "oci" })).status()).toBe(
      201,
    );
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "oras-missing-manifest" })).json()
    ).secret as string;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-missing-manifest-"));
    writeFileSync(join(work, "payload.txt"), "exists\n");

    const name = "img";
    const payloadType = "application/vnd.hootifactory.test.payload";
    const v1Ref = `${host}/${owner.orgSlug}/${repo}/${name}:v1`;
    runOras(["push", ...auth, "--format", "json", v1Ref, `payload.txt:${payloadType}`], work);

    // `oras manifest fetch` does not accept --no-tty; use plain creds.
    const plainAuth = ["--plain-http", "-u", "__token__", "-p", secret];
    const missingRef = `${host}/${owner.orgSlug}/${repo}/${name}:doesnotexist`;
    let failed = false;
    let message = "";
    try {
      runOras(["manifest", "fetch", ...plainAuth, "--format", "json", missingRef], work);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unauthorized|denied|401|403|404/i);
  });
});
