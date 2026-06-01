import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const ARTIFACT_MANIFEST_MEDIA_TYPE = "application/vnd.oci.artifact.manifest.v1+json";
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function npm(args: string[], cwd: string): void {
  execFileSync("npm", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "npmc-")) },
  });
}

function npmrc(registry: string, token: string): string {
  return `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`;
}

function publish(
  baseURL: string,
  mountPath: string,
  token: string,
  pkgName: string,
  deps: Record<string, string>,
): void {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkgName, version: "1.0.0", main: "index.js", dependencies: deps }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  npm(["publish", "--registry", registry], dir);
}

function install(baseURL: string, mountPath: string, token: string, spec: string): string {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "ins-"));
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  npm(["install", spec, "--registry", registry, "--no-audit", "--no-fund", "--no-save"], dir);
  return dir;
}

async function pollArtifact(
  ctx: APIRequestContext,
  repoId: string,
  name: string,
  timeoutMs = 60_000,
): Promise<{ id: string; state: string; policyDecision: Record<string, unknown> | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.get(`/api/repositories/${repoId}/artifacts`);
    const body = (await res.json()) as {
      artifacts: {
        id: string;
        name: string;
        state: string;
        policyDecision: Record<string, unknown> | null;
      }[];
    };
    const found = body.artifacts.find((a) => a.name === name);
    if (found && found.state !== "pending") return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`artifact ${name} was not scanned within ${timeoutMs}ms`);
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function setArtifactState(artifactId: string, state: "pending" | "clean"): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { artifacts, db, eq } from "@hootifactory/db";',
        "await db.update(artifacts).set({ state: process.env.ARTIFACT_STATE }).where(eq(artifacts.id, process.env.ARTIFACT_ID));",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_ID: artifactId,
        ARTIFACT_STATE: state,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

function scanRowsForArtifacts(artifactIds: string[]): {
  id: string;
  artifactId: string;
  status: string;
  error: string | null;
}[] {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { db, inArray, scans } from "@hootifactory/db";',
        "const artifactIds = JSON.parse(process.env.ARTIFACT_IDS);",
        "const rows = await db",
        "  .select({ id: scans.id, artifactId: scans.artifactId, status: scans.status, error: scans.error })",
        "  .from(scans)",
        "  .where(inArray(scans.artifactId, artifactIds));",
        "console.log(JSON.stringify(rows));",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_IDS: JSON.stringify(artifactIds),
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out) as {
    id: string;
    artifactId: string;
    status: string;
    error: string | null;
  }[];
}

function recordFailure(artifactId: string): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { recordScanFailure } from "./apps/scan-worker/src/pipeline.ts";',
        'await recordScanFailure(process.env.ARTIFACT_ID, new Error("forced scan failure"));',
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_ID: artifactId,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

async function publishRawNpm(
  ctx: APIRequestContext,
  mountPath: string,
  pkgName: string,
  deps: Record<string, string>,
): Promise<Buffer> {
  const tarball = Buffer.from(`artifact-${pkgName}`);
  const filename = `${pkgName}-1.0.0.tgz`;
  const res = await ctx.put(`/${mountPath}/${pkgName}`, {
    data: {
      name: pkgName,
      versions: {
        "1.0.0": {
          name: pkgName,
          version: "1.0.0",
          main: "index.js",
          dependencies: deps,
        },
      },
      _attachments: {
        [filename]: { data: tarball.toString("base64") },
      },
      "dist-tags": { latest: "1.0.0" },
    },
  });
  expect(res.status()).toBe(201);
  return tarball;
}

async function uploadOciBlob(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  bytes: Buffer,
): Promise<string> {
  const digest = sha256(bytes);
  const res = await ctx.post(`/${mountPath}/${image}/blobs/uploads?digest=${digest}`, {
    headers: { "content-type": "application/octet-stream" },
    data: bytes,
  });
  expect(res.status()).toBe(201);
  return digest;
}

async function putOciManifest(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  configDigest: string,
  layerDigest: string,
): Promise<string> {
  return putOciManifestWithLayers(ctx, mountPath, image, tag, configDigest, [
    { digest: layerDigest, size: Buffer.byteLength(EICAR) },
  ]);
}

async function putOciManifestWithLayers(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  configDigest: string,
  layers: { digest: string; size: number }[],
): Promise<string> {
  const raw = JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.manifestV1,
    config: {
      mediaType: OCI_MEDIA_TYPES.configV1,
      digest: configDigest,
      size: Buffer.byteLength("{}"),
    },
    layers: [
      ...layers.map((layer) => ({
        mediaType: OCI_MEDIA_TYPES.layerTarGzip,
        digest: layer.digest,
        size: layer.size,
      })),
    ],
  });
  const digest = sha256(raw);
  const res = await ctx.put(`/${mountPath}/${image}/manifests/${tag}`, {
    headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
    data: raw,
  });
  expect(res.status()).toBe(201);
  expect(res.headers()["docker-content-digest"]).toBe(digest);
  return digest;
}

async function putOciArtifactManifest(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  blobDigest: string,
  size: number,
): Promise<string> {
  const raw = JSON.stringify({
    schemaVersion: 2,
    mediaType: ARTIFACT_MANIFEST_MEDIA_TYPE,
    artifactType: "application/vnd.hootifactory.test.artifact",
    blobs: [
      {
        mediaType: "application/vnd.hootifactory.test.payload",
        digest: blobDigest,
        size,
      },
    ],
  });
  const digest = sha256(raw);
  const res = await ctx.put(`/${mountPath}/${image}/manifests/${tag}`, {
    headers: { "content-type": ARTIFACT_MANIFEST_MEDIA_TYPE },
    data: raw,
  });
  expect(res.status()).toBe(201);
  expect(res.headers()["docker-content-digest"]).toBe(digest);
  return digest;
}

test.describe("scanning + policy gates", () => {
  test("scan policy API rejects invalid modes, severities, and repository patterns", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    for (const data of [
      { repositoryPattern: "bad/name", mode: "audit", blockOnSeverity: "high" },
      { repositoryPattern: 42, mode: "audit", blockOnSeverity: "high" },
      { repositoryPattern: "*", mode: "deny", blockOnSeverity: "high" },
      { repositoryPattern: "*", mode: "audit", blockOnSeverity: "severe" },
    ]) {
      const res = await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, { data });
      expect(res.status()).toBe(400);
    }
  });

  test("scan policy globs resolve deterministically with exact policies winning", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const id = Date.now().toString(36);
    const prefix = `scanpolicy-${id}`;
    const exactRepoName = `${prefix}-specific`;
    const targetRepoName = `${prefix}-target`;

    for (const data of [
      { repositoryPattern: `${prefix}-*`, mode: "enforce", blockOnSeverity: "high" },
      { repositoryPattern: exactRepoName, mode: "enforce", blockOnSeverity: "high" },
      { repositoryPattern: exactRepoName, mode: "audit", blockOnSeverity: "high" },
    ]) {
      expect(
        (await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, { data })).status(),
      ).toBe(201);
    }

    const exactRepo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: exactRepoName, format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };
    const targetRepo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: targetRepoName, format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };

    const exactPkg = `exactpkg${id}`;
    const targetPkg = `targetpkg${id}`;
    const exactTarball = await publishRawNpm(owner.ctx, exactRepo.mountPath, exactPkg, {
      "evil-dep": "1.0.0",
    });
    await publishRawNpm(owner.ctx, targetRepo.mountPath, targetPkg, { "evil-dep": "1.0.0" });

    const exactArt = await pollArtifact(owner.ctx, exactRepo.id, exactPkg);
    expect(exactArt.state).toBe("quarantined");
    const targetArt = await pollArtifact(owner.ctx, targetRepo.id, targetPkg);
    expect(targetArt.state).toBe("blocked");

    setArtifactState(exactArt.id, "pending");
    const pendingExact = await owner.ctx.get(
      `/${exactRepo.mountPath}/${exactPkg}/-/${exactPkg}-1.0.0.tgz`,
    );
    expect(pendingExact.status()).toBe(200);
    expect(Buffer.from(await pendingExact.body())).toEqual(exactTarball);
  });

  test("enforce policy blocks a vulnerable package; clean package is served", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: "scanrepo", format: "npm" })).json()
    ).repository as { id: string; mountPath: string };

    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scanrepo", mode: "enforce", blockOnSeverity: "high" },
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const vulnPkg = `vulnpkg${id}`;
    const cleanPkg = `cleanpkg${id}`;

    publish(baseURL!, repo.mountPath, token, vulnPkg, { "evil-dep": "1.0.0" });
    publish(baseURL!, repo.mountPath, token, cleanPkg, {});

    // vulnerable -> blocked, with a critical finding
    const vulnArt = await pollArtifact(owner.ctx, repo.id, vulnPkg);
    expect(vulnArt.state).toBe("blocked");
    const f = (await (await owner.ctx.get(`/api/artifacts/${vulnArt.id}/findings`)).json()) as {
      findings: { vulnId: string; severity: string }[];
    };
    expect(f.findings.some((x) => x.vulnId === "HOOT-2024-0001" && x.severity === "critical")).toBe(
      true,
    );

    // clean -> clean
    const cleanArt = await pollArtifact(owner.ctx, repo.id, cleanPkg);
    expect(cleanArt.state).toBe("clean");

    // installing the clean package succeeds
    const dir = install(baseURL!, repo.mountPath, token, `${cleanPkg}@1.0.0`);
    expect(existsSync(join(dir, "node_modules", cleanPkg))).toBe(true);

    // installing the blocked package fails (tarball refused with 403)
    let blocked = false;
    try {
      install(baseURL!, repo.mountPath, token, `${vulnPkg}@1.0.0`);
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("enforce policy refuses pending artifacts until a scanner marks them clean", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "pending-npm", format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "pending-npm", mode: "enforce", blockOnSeverity: "high" },
    });

    const pkg = `pendingpkg${Date.now().toString(36)}`;
    const tarball = await publishRawNpm(owner.ctx, repo.mountPath, pkg, {});
    const art = await pollArtifact(owner.ctx, repo.id, pkg);
    expect(art.state).toBe("clean");
    setArtifactState(art.id, "pending");

    const pending = await owner.ctx.get(`/${repo.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
    expect(pending.status()).toBe(403);

    setArtifactState(art.id, "clean");
    const clean = await owner.ctx.get(`/${repo.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
    expect(clean.status()).toBe(200);
    expect(Buffer.from(await clean.body())).toEqual(tarball);
  });

  test("scan failure recording upserts on the per-artifact scan key", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "failure-npm", format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };

    const pkg = `failurepkg${Date.now().toString(36)}`;
    await publishRawNpm(owner.ctx, repo.mountPath, pkg, {});
    const art = await pollArtifact(owner.ctx, repo.id, pkg);
    expect(art.state).toBe("clean");

    recordFailure(art.id);
    recordFailure(art.id);

    const rows = scanRowsForArtifacts([art.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      artifactId: art.id,
      status: "failed",
      error: "forced scan failure",
    });
    const listed = (
      (await (await owner.ctx.get(`/api/repositories/${repo.id}/artifacts`)).json()) as {
        artifacts: { id: string; policyDecision: Record<string, unknown> | null }[];
      }
    ).artifacts.find((artifact) => artifact.id === art.id);
    expect(listed?.policyDecision).toMatchObject({
      scanStatus: "failed",
      error: "forced scan failure",
    });
  });

  test("enforce policy blocks OCI manifests whose referenced blobs contain malware", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "scan-containers", format: "docker" })
      ).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scan-containers", mode: "enforce", blockOnSeverity: "high" },
    });

    const image = `eicar${Date.now().toString(36)}`;
    const configDigest = await uploadOciBlob(owner.ctx, repo.mountPath, image, Buffer.from("{}"));
    const layerDigest = await uploadOciBlob(owner.ctx, repo.mountPath, image, Buffer.from(EICAR));
    await putOciManifest(owner.ctx, repo.mountPath, image, "1.0", configDigest, layerDigest);

    const art = await pollArtifact(owner.ctx, repo.id, image);
    expect(art.state).toBe("blocked");
    const findings = (await (await owner.ctx.get(`/api/artifacts/${art.id}/findings`)).json()) as {
      findings: { vulnId: string; severity: string; type: string }[];
    };
    expect(findings.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "malware", vulnId: "EICAR-TEST", severity: "critical" }),
      ]),
    );

    const blocked = await owner.ctx.get(`/${repo.mountPath}/${image}/manifests/1.0`);
    expect(blocked.status()).toBe(403);

    const blockedBlob = await owner.ctx.get(`/${repo.mountPath}/${image}/blobs/${layerDigest}`);
    expect(blockedBlob.status()).toBe(403);
    const blockedBlobHead = await owner.ctx.head(
      `/${repo.mountPath}/${image}/blobs/${layerDigest}`,
    );
    expect(blockedBlobHead.status()).toBe(403);
    const blockedBlobRange = await owner.ctx.get(
      `/${repo.mountPath}/${image}/blobs/${layerDigest}`,
      {
        headers: { range: "bytes=0-3" },
      },
    );
    expect(blockedBlobRange.status()).toBe(403);

    setArtifactState(art.id, "pending");
    const pendingManifest = await owner.ctx.get(`/${repo.mountPath}/${image}/manifests/1.0`);
    expect(pendingManifest.status()).toBe(403);
    const pendingBlob = await owner.ctx.get(`/${repo.mountPath}/${image}/blobs/${layerDigest}`);
    expect(pendingBlob.status()).toBe(403);
  });

  test("OCI blob scan gates are image-scoped", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "scan-shared", format: "docker" })
      ).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scan-shared", mode: "enforce", blockOnSeverity: "high" },
    });

    const id = Date.now().toString(36);
    const cleanImage = `clean${id}`;
    const blockedImage = `blocked${id}`;
    const sharedLayer = Buffer.from("shared clean layer");
    const evilLayer = Buffer.from(EICAR);

    const cleanConfig = await uploadOciBlob(
      owner.ctx,
      repo.mountPath,
      cleanImage,
      Buffer.from("{}"),
    );
    const cleanShared = await uploadOciBlob(owner.ctx, repo.mountPath, cleanImage, sharedLayer);
    await putOciManifestWithLayers(owner.ctx, repo.mountPath, cleanImage, "1.0", cleanConfig, [
      { digest: cleanShared, size: sharedLayer.byteLength },
    ]);
    const cleanArt = await pollArtifact(owner.ctx, repo.id, cleanImage);
    expect(cleanArt.state).toBe("clean");

    const blockedConfig = await uploadOciBlob(
      owner.ctx,
      repo.mountPath,
      blockedImage,
      Buffer.from("{}"),
    );
    const blockedShared = await uploadOciBlob(owner.ctx, repo.mountPath, blockedImage, sharedLayer);
    const blockedEvil = await uploadOciBlob(owner.ctx, repo.mountPath, blockedImage, evilLayer);
    expect(blockedShared).toBe(cleanShared);
    await putOciManifestWithLayers(owner.ctx, repo.mountPath, blockedImage, "1.0", blockedConfig, [
      { digest: blockedShared, size: sharedLayer.byteLength },
      { digest: blockedEvil, size: evilLayer.byteLength },
    ]);
    const blockedArt = await pollArtifact(owner.ctx, repo.id, blockedImage);
    expect(blockedArt.state).toBe("blocked");

    const cleanSharedBlob = await owner.ctx.get(
      `/${repo.mountPath}/${cleanImage}/blobs/${cleanShared}`,
    );
    expect(cleanSharedBlob.status()).toBe(200);

    const blockedSharedBlob = await owner.ctx.get(
      `/${repo.mountPath}/${blockedImage}/blobs/${blockedShared}`,
    );
    expect(blockedSharedBlob.status()).toBe(403);

    const blockedEvilBlob = await owner.ctx.get(
      `/${repo.mountPath}/${blockedImage}/blobs/${blockedEvil}`,
    );
    expect(blockedEvilBlob.status()).toBe(403);
  });

  test("enforce policy blocks OCI artifact manifest blobs", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: "scan-oci", format: "oci" })).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scan-oci", mode: "enforce", blockOnSeverity: "high" },
    });

    const image = `artifact${Date.now().toString(36)}`;
    const payload = Buffer.from(EICAR);
    const payloadDigest = await uploadOciBlob(owner.ctx, repo.mountPath, image, payload);
    await putOciArtifactManifest(
      owner.ctx,
      repo.mountPath,
      image,
      "v1",
      payloadDigest,
      payload.byteLength,
    );

    const art = await pollArtifact(owner.ctx, repo.id, image);
    expect(art.state).toBe("blocked");

    const blockedManifest = await owner.ctx.get(`/${repo.mountPath}/${image}/manifests/v1`);
    expect(blockedManifest.status()).toBe(403);
    const blockedBlob = await owner.ctx.get(`/${repo.mountPath}/${image}/blobs/${payloadDigest}`);
    expect(blockedBlob.status()).toBe(403);
  });

  test("identical OCI bytes still get per-artifact scan rows", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const firstRepo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "dedupe-a", format: "docker" })
      ).json()
    ).repository as { id: string; mountPath: string };
    const secondRepo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "dedupe-b", format: "docker" })
      ).json()
    ).repository as { id: string; mountPath: string };

    const image = `dedupe${Date.now().toString(36)}`;
    const configBytes = Buffer.from("{}");
    const layerBytes = Buffer.from("same clean layer");
    const firstConfig = await uploadOciBlob(owner.ctx, firstRepo.mountPath, image, configBytes);
    const firstLayer = await uploadOciBlob(owner.ctx, firstRepo.mountPath, image, layerBytes);
    const secondConfig = await uploadOciBlob(owner.ctx, secondRepo.mountPath, image, configBytes);
    const secondLayer = await uploadOciBlob(owner.ctx, secondRepo.mountPath, image, layerBytes);
    expect(secondConfig).toBe(firstConfig);
    expect(secondLayer).toBe(firstLayer);
    const firstManifest = await putOciManifest(
      owner.ctx,
      firstRepo.mountPath,
      image,
      "1.0",
      firstConfig,
      firstLayer,
    );
    const secondManifest = await putOciManifest(
      owner.ctx,
      secondRepo.mountPath,
      image,
      "1.0",
      secondConfig,
      secondLayer,
    );
    expect(secondManifest).toBe(firstManifest);

    const firstArt = await pollArtifact(owner.ctx, firstRepo.id, image);
    const secondArt = await pollArtifact(owner.ctx, secondRepo.id, image);
    expect(firstArt.state).toBe("clean");
    expect(secondArt.state).toBe("clean");

    const scanRows = scanRowsForArtifacts([firstArt.id, secondArt.id]);
    expect(scanRows.map((s) => s.artifactId).sort()).toEqual([firstArt.id, secondArt.id].sort());
  });
});
