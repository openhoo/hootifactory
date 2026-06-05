import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { OCI_MEDIA_TYPES } from "@hootifactory/registry-oci";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const ARTIFACT_MANIFEST_MEDIA_TYPE = "application/vnd.oci.artifact.manifest.v1+json";

function basic(secret: string): string {
  return `Basic ${Buffer.from(`token:${secret}`).toString("base64")}`;
}

async function registryToken(
  ctx: APIRequestContext,
  scope: string,
  secret: string,
): Promise<string> {
  const res = await ctx.get(`/token?service=hootifactory&scope=${encodeURIComponent(scope)}`, {
    headers: { authorization: basic(secret) },
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function insertLegacyRepository(input: {
  orgId: string;
  name: string;
  moduleId: "npm";
  mountPath: string;
  storagePrefix: string;
}): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { db, repositories } from "@hootifactory/db";',
        "await db.insert(repositories).values({",
        "  orgId: process.env.ORG_ID,",
        "  name: process.env.REPOSITORY_NAME,",
        "  moduleId: process.env.MODULE_ID,",
        "  mountPath: process.env.MOUNT_PATH,",
        "  storagePrefix: process.env.STORAGE_PREFIX,",
        "});",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ORG_ID: input.orgId,
        REPOSITORY_NAME: input.name,
        MODULE_ID: input.moduleId,
        MOUNT_PATH: input.mountPath,
        STORAGE_PREFIX: input.storagePrefix,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

async function uploadBlob(
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
  expect(res.headers()["docker-content-digest"]).toBe(digest);
  return digest;
}

async function startUpload(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
): Promise<{ uuid: string; path: string }> {
  const res = await ctx.post(`/${mountPath}/${image}/blobs/uploads`);
  expect(res.status()).toBe(202);
  const uuid = res.headers()["docker-upload-uuid"];
  expect(uuid).toBeTruthy();
  expect(res.headers().range).toBe("0-0");
  return { uuid, path: `/${mountPath}/${image}/blobs/uploads/${uuid}` };
}

function expireUploadSession(uuid: string): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { db, eq, uploadSessions } from "@hootifactory/db";',
        "await db",
        "  .update(uploadSessions)",
        "  .set({ expiresAt: new Date(Date.now() - 1000) })",
        "  .where(eq(uploadSessions.id, process.env.UPLOAD_UUID));",
      ].join("\n"),
    ],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, UPLOAD_UUID: uuid },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

function casBlobState(digest: string): { dbRows: number; exists: boolean } {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { blobStore } from "@hootifactory/storage";',
        'import { blobs, db, eq } from "@hootifactory/db";',
        "const rows = await db",
        "  .select({ digest: blobs.digest })",
        "  .from(blobs)",
        "  .where(eq(blobs.digest, process.env.DIGEST));",
        "console.log(JSON.stringify({",
        "  dbRows: rows.length,",
        "  exists: await blobStore.exists(process.env.DIGEST),",
        "}));",
      ].join("\n"),
    ],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DIGEST: digest },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out);
}

function uploadSessionState(uuid: string): {
  chunkExists: boolean[];
  offsetBytes: number | null;
  state: string | null;
  storageExists: boolean | null;
} {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { blobStore } from "@hootifactory/storage";',
        'import { db, eq, uploadSessions } from "@hootifactory/db";',
        "const [session] = await db",
        "  .select()",
        "  .from(uploadSessions)",
        "  .where(eq(uploadSessions.id, process.env.UPLOAD_UUID));",
        "if (!session) {",
        "  console.log(JSON.stringify({ state: null, offsetBytes: null, storageExists: null, chunkExists: [] }));",
        "} else {",
        "  let chunks = [];",
        "  try { chunks = JSON.parse(session.multipart ?? '{}').chunks ?? []; } catch {}",
        "  const keys = chunks.flatMap((chunk) => typeof chunk?.key === 'string' ? [chunk.key] : []);",
        "  console.log(JSON.stringify({",
        "    state: session.state,",
        "    offsetBytes: session.offsetBytes,",
        "    storageExists: await blobStore.existsKey(session.storageKey),",
        "    chunkExists: await Promise.all(keys.map((key) => blobStore.existsKey(key))),",
        "  }));",
        "}",
      ].join("\n"),
    ],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, UPLOAD_UUID: uuid },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out);
}

function reapExpiredUploadSessions(): { aborted: number } {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { reapExpiredContentUploadSessions } from "@hootifactory/registry-application";',
        "console.log(JSON.stringify(await reapExpiredContentUploadSessions({ limit: 10 })));",
      ].join("\n"),
    ],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out);
}

async function putManifest(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  configDigest: string,
  layerDigest: string,
): Promise<string> {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.manifestV1,
    config: {
      mediaType: OCI_MEDIA_TYPES.configV1,
      digest: configDigest,
      size: Buffer.byteLength("{}"),
    },
    layers: [
      {
        mediaType: OCI_MEDIA_TYPES.layerTarGzip,
        digest: layerDigest,
        size: Buffer.byteLength("layer-a"),
      },
    ],
  });
  const digest = sha256(manifest);
  const res = await ctx.put(`/${mountPath}/${image}/manifests/${tag}`, {
    headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
    data: manifest,
  });
  expect(res.status()).toBe(201);
  expect(res.headers()["docker-content-digest"]).toBe(digest);
  return digest;
}

function referrerManifest(
  subjectDigest: string,
  opts: { artifactType?: string; annotations?: Record<string, string> } = {},
): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: ARTIFACT_MANIFEST_MEDIA_TYPE,
    artifactType: opts.artifactType ?? "application/vnd.hootifactory.test.sbom",
    subject: {
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      digest: subjectDigest,
      size: 0,
    },
    annotations: opts.annotations,
  });
}

function artifactManifestWithBlob(blobDigest: string, size: number): string {
  return JSON.stringify({
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
}

async function putReferrer(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  subjectDigest: string,
): Promise<string> {
  const manifest = referrerManifest(subjectDigest);
  const digest = sha256(manifest);
  const res = await ctx.put(`/${mountPath}/${image}/manifests/${tag}`, {
    headers: { "content-type": ARTIFACT_MANIFEST_MEDIA_TYPE },
    data: manifest,
  });
  expect(res.status()).toBe(201);
  expect(res.headers()["docker-content-digest"]).toBe(digest);
  return digest;
}

test.describe("docker registry protocol authorization", () => {
  test("OCI bearer JWTs cannot authorize non-OCI registry modules", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    expect(
      (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).status(),
    ).toBe(201);
    const imageName = `${owner.orgSlug}/containers/app`;
    const legacyMount = `npm/${owner.orgSlug}/${imageName}`;
    insertLegacyRepository({
      orgId: owner.orgId,
      name: imageName,
      moduleId: "npm",
      mountPath: legacyMount,
      storagePrefix: `${owner.orgId}/legacy-cross-module`,
    });

    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "oci-reader",
          grants: [{ resource: "repository", repository: imageName, actions: ["read"] }],
        })
      ).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const jwt = await registryToken(anon, `repository:${imageName}:pull`, secret);

    const res = await anon.get(`/${legacyMount}/-/whoami`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status()).toBe(403);
  });

  test("tokens and digest endpoints are scoped to the requested image", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).json()
    ).repository as { mountPath: string };

    const configDigest = await uploadBlob(owner.ctx, repo.mountPath, "app", Buffer.from("{}"));
    const layerDigest = await uploadBlob(owner.ctx, repo.mountPath, "app", Buffer.from("layer-a"));
    const manifestDigest = await putManifest(
      owner.ctx,
      repo.mountPath,
      "app",
      "1.0",
      configDigest,
      layerDigest,
    );

    const anon = await anonContext(baseURL!);
    const repoNameOnlySecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "repo-name-only",
          grants: [{ resource: "repository", repository: "containers", actions: ["read"] }],
        })
      ).json()
    ).secret as string;
    const repoNameOnlyJwt = await registryToken(
      anon,
      `repository:${owner.orgSlug}/containers/app:pull`,
      repoNameOnlySecret,
    );
    const repoNameOnlyManifest = await anon.get(`/${repo.mountPath}/app/manifests/1.0`, {
      headers: { authorization: `Bearer ${repoNameOnlyJwt}` },
    });
    expect(repoNameOnlyManifest.status()).toBe(401);
    expect(repoNameOnlyManifest.headers()["www-authenticate"]).toContain(
      `scope="repository:${owner.orgSlug}/containers/app:pull"`,
    );
    expect(repoNameOnlyManifest.headers()["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );

    const wrongService = await anon.get(
      `/token?service=wrong&scope=${encodeURIComponent(
        `repository:${owner.orgSlug}/containers/app:pull`,
      )}`,
      { headers: { authorization: basic(repoNameOnlySecret) } },
    );
    expect(wrongService.status()).toBe(401);

    const invalidBearer = await anon.head(`/${repo.mountPath}/app/manifests/1.0`, {
      headers: { authorization: "Bearer not-a-registry-token" },
    });
    expect(invalidBearer.status()).toBe(401);
    expect(invalidBearer.headers()["www-authenticate"]).toContain('error="invalid_token"');

    const appSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "app-reader",
          grants: [
            {
              resource: "repository",
              repository: `${owner.orgSlug}/containers/app`,
              actions: ["read"],
            },
          ],
        })
      ).json()
    ).secret as string;
    const appJwt = await registryToken(
      anon,
      `repository:${owner.orgSlug}/containers/app:pull`,
      appSecret,
    );
    const appManifest = await anon.get(`/${repo.mountPath}/app/manifests/1.0`, {
      headers: { authorization: `Bearer ${appJwt}` },
    });
    expect(appManifest.status()).toBe(200);

    const otherSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "other-reader",
          grants: [
            {
              resource: "repository",
              repository: `${owner.orgSlug}/containers/other`,
              actions: ["read"],
            },
          ],
        })
      ).json()
    ).secret as string;
    const otherJwt = await registryToken(
      anon,
      `repository:${owner.orgSlug}/containers/other:pull`,
      otherSecret,
    );

    const crossBlob = await anon.get(`/${repo.mountPath}/other/blobs/${layerDigest}`, {
      headers: { authorization: `Bearer ${otherJwt}` },
    });
    expect(crossBlob.status()).toBe(404);
    expect((await crossBlob.json()).errors[0].code).toBe("BLOB_UNKNOWN");

    const crossManifest = await anon.get(`/${repo.mountPath}/other/manifests/${manifestDigest}`, {
      headers: { authorization: `Bearer ${otherJwt}` },
    });
    expect(crossManifest.status()).toBe(404);
    expect((await crossManifest.json()).errors[0].code).toBe("MANIFEST_UNKNOWN");

    const otherDeleteSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "other-deleter",
          grants: [
            {
              resource: "repository",
              repository: `${owner.orgSlug}/containers/other`,
              actions: ["read", "delete"],
            },
          ],
        })
      ).json()
    ).secret as string;
    const otherDeleteJwt = await registryToken(
      anon,
      `repository:${owner.orgSlug}/containers/other:pull,delete`,
      otherDeleteSecret,
    );
    const crossDelete = await anon.delete(`/${repo.mountPath}/other/manifests/${manifestDigest}`, {
      headers: { authorization: `Bearer ${otherDeleteJwt}` },
    });
    expect(crossDelete.status()).toBe(404);
    expect((await crossDelete.json()).errors[0].code).toBe("MANIFEST_UNKNOWN");

    const badManifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      config: {
        mediaType: OCI_MEDIA_TYPES.configV1,
        digest: configDigest,
        size: Buffer.byteLength("{}"),
      },
      layers: [
        {
          mediaType: OCI_MEDIA_TYPES.layerTarGzip,
          digest: layerDigest,
          size: Buffer.byteLength("layer-a"),
        },
      ],
    });
    const rejected = await owner.ctx.put(`/${repo.mountPath}/other/manifests/1.0`, {
      headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
      data: badManifest,
    });
    expect(rejected.status()).toBe(404);
    expect((await rejected.json()).errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");

    const stillThere = await anon.get(`/${repo.mountPath}/app/manifests/1.0`, {
      headers: { authorization: `Bearer ${appJwt}` },
    });
    expect(stillThere.status()).toBe(200);
  });

  test("manifest references and media types follow OCI rules", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).json()
    ).repository as { mountPath: string };

    const configDigest = await uploadBlob(owner.ctx, repo.mountPath, "strict", Buffer.from("{}"));
    const layerDigest = await uploadBlob(
      owner.ctx,
      repo.mountPath,
      "strict",
      Buffer.from("layer-strict"),
    );
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      config: {
        mediaType: OCI_MEDIA_TYPES.configV1,
        digest: configDigest,
        size: Buffer.byteLength("{}"),
      },
      layers: [
        {
          mediaType: OCI_MEDIA_TYPES.layerTarGzip,
          digest: layerDigest,
          size: Buffer.byteLength("layer-strict"),
        },
      ],
    });
    const put = await owner.ctx.put(`/${repo.mountPath}/strict/manifests/v1`, {
      headers: { "content-type": `${OCI_MEDIA_TYPES.manifestV1}; charset=utf-8` },
      data: manifest,
    });
    expect(put.status()).toBe(201);

    const accepted = await owner.ctx.get(`/${repo.mountPath}/strict/manifests/v1`, {
      headers: { accept: OCI_MEDIA_TYPES.manifestV1 },
    });
    expect(accepted.status()).toBe(200);
    expect(accepted.headers()["content-type"]).toBe(OCI_MEDIA_TYPES.manifestV1);

    const narrowAccept = await owner.ctx.get(`/${repo.mountPath}/strict/manifests/v1`, {
      headers: { accept: OCI_MEDIA_TYPES.imageIndexV1 },
    });
    expect(narrowAccept.status()).toBe(200);
    expect(narrowAccept.headers()["content-type"]).toBe(OCI_MEDIA_TYPES.manifestV1);
    expect(await narrowAccept.text()).toBe(manifest);

    const badTag = await owner.ctx.put(`/${repo.mountPath}/strict/manifests/bad:tag`, {
      headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
      data: manifest,
    });
    expect(badTag.status()).toBe(400);
    expect((await badTag.json()).errors[0].code).toBe("TAG_INVALID");

    const badDigestRef = await owner.ctx.get(`/${repo.mountPath}/strict/manifests/sha256:abc`);
    expect(badDigestRef.status()).toBe(400);
    expect((await badDigestRef.json()).errors[0].code).toBe("DIGEST_INVALID");

    const unsupported = await owner.ctx.put(`/${repo.mountPath}/strict/manifests/text`, {
      headers: { "content-type": "text/plain" },
      data: manifest,
    });
    expect(unsupported.status()).toBe(400);
    expect((await unsupported.json()).errors[0].code).toBe("UNSUPPORTED");

    const unknownChild = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.imageIndexV1,
      manifests: [
        {
          mediaType: OCI_MEDIA_TYPES.manifestV1,
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size: 123,
        },
      ],
    });
    const rejectedIndex = await owner.ctx.put(`/${repo.mountPath}/strict/manifests/index`, {
      headers: { "content-type": OCI_MEDIA_TYPES.imageIndexV1 },
      data: unknownChild,
    });
    expect(rejectedIndex.status()).toBe(404);
    expect((await rejectedIndex.json()).errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");

    const missingTagDelete = await owner.ctx.delete(`/${repo.mountPath}/strict/manifests/missing`);
    expect(missingTagDelete.status()).toBe(404);
    expect((await missingTagDelete.json()).errors[0].code).toBe("MANIFEST_UNKNOWN");

    const zeroTags = await owner.ctx.get(`/${repo.mountPath}/strict/tags/list?n=0`);
    expect(zeroTags.status()).toBe(200);
    expect((await zeroTags.json()).tags).toEqual([]);
    expect(zeroTags.headers().link).toBeUndefined();

    const invalidTagPage = await owner.ctx.get(`/${repo.mountPath}/strict/tags/list?n=-1`);
    expect(invalidTagPage.status()).toBe(400);
    expect((await invalidTagPage.json()).errors[0].code).toBe("PAGINATION_NUMBER_INVALID");

    const invalidLast = await owner.ctx.get(`/${repo.mountPath}/strict/tags/list?last=bad:tag`);
    expect(invalidLast.status()).toBe(400);
    expect((await invalidLast.json()).errors[0].code).toBe("TAG_INVALID");
  });

  test("manifest referrers and digest deletes stay scoped to the requested image", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).json()
    ).repository as { mountPath: string };

    const appConfigDigest = await uploadBlob(owner.ctx, repo.mountPath, "app", Buffer.from("{}"));
    const appLayerDigest = await uploadBlob(
      owner.ctx,
      repo.mountPath,
      "app",
      Buffer.from("layer-app"),
    );
    const appDigest = await putManifest(
      owner.ctx,
      repo.mountPath,
      "app",
      "1.0",
      appConfigDigest,
      appLayerDigest,
    );
    const appReferrerDigest = await putReferrer(
      owner.ctx,
      repo.mountPath,
      "app",
      "sbom",
      appDigest,
    );

    const appReferrers = await owner.ctx.get(`/${repo.mountPath}/app/referrers/${appDigest}`);
    expect(appReferrers.status()).toBe(200);
    expect(((await appReferrers.json()) as { manifests: { digest: string }[] }).manifests).toEqual(
      expect.arrayContaining([expect.objectContaining({ digest: appReferrerDigest })]),
    );

    const futureSubject = sha256("future subject manifest");
    const earlyType = "application/vnd.hootifactory.test.early";
    const earlyReferrer = referrerManifest(futureSubject, {
      artifactType: earlyType,
      annotations: { "org.opencontainers.image.title": "early-referrer" },
    });
    const earlyDigest = sha256(earlyReferrer);
    const earlyPut = await owner.ctx.put(`/${repo.mountPath}/pre/manifests/sbom`, {
      headers: { "content-type": ARTIFACT_MANIFEST_MEDIA_TYPE },
      data: earlyReferrer,
    });
    expect(earlyPut.status()).toBe(201);
    expect(earlyPut.headers()["oci-subject"]).toBe(futureSubject);

    const invalidReferrers = await owner.ctx.get(`/${repo.mountPath}/pre/referrers/sha256:bad`);
    expect(invalidReferrers.status()).toBe(400);
    expect((await invalidReferrers.json()).errors[0].code).toBe("DIGEST_INVALID");

    const filteredReferrers = await owner.ctx.get(
      `/${repo.mountPath}/pre/referrers/${futureSubject}?artifactType=${encodeURIComponent(
        earlyType,
      )}`,
    );
    expect(filteredReferrers.status()).toBe(200);
    expect(filteredReferrers.headers()["oci-filters-applied"]).toBe("artifactType");
    expect(await filteredReferrers.json()).toMatchObject({
      manifests: [
        {
          artifactType: earlyType,
          digest: earlyDigest,
          annotations: { "org.opencontainers.image.title": "early-referrer" },
        },
      ],
    });

    const filteredMiss = await owner.ctx.get(
      `/${repo.mountPath}/pre/referrers/${futureSubject}?artifactType=application%2Fmissing`,
    );
    expect(filteredMiss.status()).toBe(200);
    expect(((await filteredMiss.json()) as { manifests: unknown[] }).manifests).toEqual([]);

    const crossBody = referrerManifest(appDigest, {
      artifactType: "application/vnd.hootifactory.test.other",
    });
    const crossDigest = sha256(crossBody);
    const crossReferrer = await owner.ctx.put(`/${repo.mountPath}/other/manifests/sbom`, {
      headers: { "content-type": ARTIFACT_MANIFEST_MEDIA_TYPE },
      data: crossBody,
    });
    expect(crossReferrer.status()).toBe(201);

    const otherReferrers = await owner.ctx.get(`/${repo.mountPath}/other/referrers/${appDigest}`);
    expect(otherReferrers.status()).toBe(200);
    expect(
      ((await otherReferrers.json()) as { manifests: { digest: string }[] }).manifests,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ digest: crossDigest })]));

    const otherConfigDigest = await uploadBlob(
      owner.ctx,
      repo.mountPath,
      "other",
      Buffer.from("{}"),
    );
    const otherLayerDigest = await uploadBlob(
      owner.ctx,
      repo.mountPath,
      "other",
      Buffer.from("shared-layer"),
    );
    const sharedAppConfigDigest = await uploadBlob(
      owner.ctx,
      repo.mountPath,
      "app-shared",
      Buffer.from("{}"),
    );
    const sharedAppLayerDigest = await uploadBlob(
      owner.ctx,
      repo.mountPath,
      "app-shared",
      Buffer.from("shared-layer"),
    );
    const sharedAppDigest = await putManifest(
      owner.ctx,
      repo.mountPath,
      "app-shared",
      "1.0",
      sharedAppConfigDigest,
      sharedAppLayerDigest,
    );
    const sharedOtherDigest = await putManifest(
      owner.ctx,
      repo.mountPath,
      "other",
      "1.0",
      otherConfigDigest,
      otherLayerDigest,
    );
    expect(sharedOtherDigest).toBe(sharedAppDigest);

    const deleted = await owner.ctx.delete(
      `/${repo.mountPath}/app-shared/manifests/${sharedAppDigest}`,
    );
    expect(deleted.status()).toBe(202);

    const appSharedAfterDelete = await owner.ctx.get(`/${repo.mountPath}/app-shared/manifests/1.0`);
    expect(appSharedAfterDelete.status()).toBe(404);
    expect((await appSharedAfterDelete.json()).errors[0].code).toBe("MANIFEST_UNKNOWN");

    const otherAfterDelete = await owner.ctx.get(`/${repo.mountPath}/other/manifests/1.0`);
    expect(otherAfterDelete.status()).toBe(200);
    expect(otherAfterDelete.headers()["docker-content-digest"]).toBe(sharedOtherDigest);

    const appSharedBlobAfterDelete = await owner.ctx.get(
      `/${repo.mountPath}/app-shared/blobs/${sharedAppLayerDigest}`,
    );
    expect(appSharedBlobAfterDelete.status()).toBe(404);
    expect((await appSharedBlobAfterDelete.json()).errors[0].code).toBe("BLOB_UNKNOWN");

    const otherBlobAfterDelete = await owner.ctx.get(
      `/${repo.mountPath}/other/blobs/${otherLayerDigest}`,
    );
    expect(otherBlobAfterDelete.status()).toBe(200);
  });

  test("OCI artifact manifest blobs are validated and released by image scope", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "artifacts", moduleId: "oci" })
      ).json()
    ).repository as { mountPath: string };

    const payload = Buffer.from("artifact payload");
    const payloadDigest = await uploadBlob(owner.ctx, repo.mountPath, "demo", payload);
    const manifest = artifactManifestWithBlob(payloadDigest, payload.byteLength);
    const manifestDigest = sha256(manifest);

    const put = await owner.ctx.put(`/${repo.mountPath}/demo/manifests/v1`, {
      headers: { "content-type": ARTIFACT_MANIFEST_MEDIA_TYPE },
      data: manifest,
    });
    expect(put.status()).toBe(201);
    expect(put.headers()["docker-content-digest"]).toBe(manifestDigest);

    const crossImage = await owner.ctx.put(`/${repo.mountPath}/other/manifests/v1`, {
      headers: { "content-type": ARTIFACT_MANIFEST_MEDIA_TYPE },
      data: manifest,
    });
    expect(crossImage.status()).toBe(404);
    expect((await crossImage.json()).errors[0].code).toBe("MANIFEST_BLOB_UNKNOWN");

    const payloadBeforeDelete = await owner.ctx.get(
      `/${repo.mountPath}/demo/blobs/${payloadDigest}`,
    );
    expect(payloadBeforeDelete.status()).toBe(200);

    const deleted = await owner.ctx.delete(`/${repo.mountPath}/demo/manifests/${manifestDigest}`);
    expect(deleted.status()).toBe(202);

    const payloadAfterDelete = await owner.ctx.get(
      `/${repo.mountPath}/demo/blobs/${payloadDigest}`,
    );
    expect(payloadAfterDelete.status()).toBe(404);
    expect((await payloadAfterDelete.json()).errors[0].code).toBe("BLOB_UNKNOWN");
  });

  test("blob downloads honor single byte ranges", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).json()
    ).repository as { mountPath: string };

    const bytes = Buffer.from("0123456789abcdef");
    const digest = await uploadBlob(owner.ctx, repo.mountPath, "ranges", bytes);
    const path = `/${repo.mountPath}/ranges/blobs/${digest}`;

    const fullHead = await owner.ctx.head(path);
    expect(fullHead.status()).toBe(200);
    expect(fullHead.headers()["accept-ranges"]).toBe("bytes");
    expect(fullHead.headers()["content-length"]).toBe(String(bytes.length));

    const middle = await owner.ctx.get(path, { headers: { range: "bytes=2-5" } });
    expect(middle.status()).toBe(206);
    expect(middle.headers()["docker-content-digest"]).toBe(digest);
    expect(middle.headers()["content-range"]).toBe(`bytes 2-5/${bytes.length}`);
    expect(middle.headers()["content-length"]).toBe("4");
    expect(Buffer.from(await middle.body()).toString("utf8")).toBe("2345");

    const openEnded = await owner.ctx.get(path, { headers: { range: "bytes=6-" } });
    expect(openEnded.status()).toBe(206);
    expect(openEnded.headers()["content-range"]).toBe(`bytes 6-15/${bytes.length}`);
    expect(Buffer.from(await openEnded.body()).toString("utf8")).toBe("6789abcdef");

    const suffix = await owner.ctx.get(path, { headers: { range: "bytes=-4" } });
    expect(suffix.status()).toBe(206);
    expect(suffix.headers()["content-range"]).toBe(`bytes 12-15/${bytes.length}`);
    expect(Buffer.from(await suffix.body()).toString("utf8")).toBe("cdef");

    const rangeHead = await owner.ctx.head(path, { headers: { range: "bytes=1-3" } });
    expect(rangeHead.status()).toBe(200);
    expect(rangeHead.headers()["content-range"]).toBeUndefined();
    expect(rangeHead.headers()["content-length"]).toBe(String(bytes.length));

    const outOfBounds = await owner.ctx.get(path, { headers: { range: "bytes=999-" } });
    expect(outOfBounds.status()).toBe(416);
    expect(outOfBounds.headers()["content-range"]).toBe(`bytes */${bytes.length}`);

    const multiRange = await owner.ctx.get(path, { headers: { range: "bytes=0-1,3-4" } });
    expect(multiRange.status()).toBe(416);
    expect(multiRange.headers()["content-range"]).toBe(`bytes */${bytes.length}`);

    const malformedDigest = await owner.ctx.get(`/${repo.mountPath}/ranges/blobs/sha256:bad`);
    expect(malformedDigest.status()).toBe(400);
    expect((await malformedDigest.json()).errors[0].code).toBe("DIGEST_INVALID");

    const deleted = await owner.ctx.delete(path);
    expect(deleted.status()).toBe(202);
    expect(deleted.headers()["docker-content-digest"]).toBe(digest);

    const afterDelete = await owner.ctx.get(path);
    expect(afterDelete.status()).toBe(404);
    expect((await afterDelete.json()).errors[0].code).toBe("BLOB_UNKNOWN");
  });

  test("resumable uploads enforce offsets, digest retries, and session state", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).json()
    ).repository as { mountPath: string };

    const upload = await startUpload(owner.ctx, repo.mountPath, "resumable");
    const readSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "resumable-reader",
          grants: [
            {
              resource: "repository",
              repository: `${owner.orgSlug}/containers/resumable`,
              actions: ["read"],
            },
          ],
        })
      ).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const readJwt = await registryToken(
      anon,
      `repository:${owner.orgSlug}/containers/resumable:pull`,
      readSecret,
    );
    const readOnlyStatus = await anon.get(upload.path, {
      headers: { authorization: `Bearer ${readJwt}` },
    });
    expect(readOnlyStatus.status()).toBe(401);
    expect(readOnlyStatus.headers()["www-authenticate"]).toContain('error="insufficient_scope"');

    const wrongImagePath = `/${repo.mountPath}/other-image/blobs/uploads/${upload.uuid}`;
    const wrongImageStatus = await owner.ctx.get(wrongImagePath);
    expect(wrongImageStatus.status()).toBe(404);
    expect((await wrongImageStatus.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");

    const wrongImagePatch = await owner.ctx.patch(wrongImagePath, {
      headers: { "content-type": "application/octet-stream", "content-range": "0-2" },
      data: Buffer.from("bad"),
    });
    expect(wrongImagePatch.status()).toBe(404);
    expect((await wrongImagePatch.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");

    const first = Buffer.from("hello");
    const firstPatch = await owner.ctx.patch(upload.path, {
      headers: { "content-type": "application/octet-stream", "content-range": "0-4" },
      data: first,
    });
    expect(firstPatch.status()).toBe(202);
    expect(firstPatch.headers().range).toBe("0-4");

    const badRange = await owner.ctx.patch(upload.path, {
      headers: { "content-type": "application/octet-stream", "content-range": "0-2" },
      data: Buffer.from("bad"),
    });
    expect(badRange.status()).toBe(416);
    expect((await badRange.json()).errors[0].code).toBe("BLOB_UPLOAD_INVALID");

    const statusAfterBadRange = await owner.ctx.get(upload.path);
    expect(statusAfterBadRange.status()).toBe(204);
    expect(statusAfterBadRange.headers().range).toBe("0-4");

    const second = Buffer.from(" world");
    const badDigest = await owner.ctx.put(`${upload.path}?digest=${sha256("wrong")}`, {
      headers: { "content-type": "application/octet-stream", "content-range": "5-10" },
      data: second,
    });
    expect(badDigest.status()).toBe(400);
    expect((await badDigest.json()).errors[0].code).toBe("DIGEST_INVALID");

    const statusAfterBadDigest = await owner.ctx.get(upload.path);
    expect(statusAfterBadDigest.status()).toBe(204);
    expect(statusAfterBadDigest.headers().range).toBe("0-4");

    const full = Buffer.concat([first, second]);
    const digest = sha256(full);
    const completed = await owner.ctx.put(`${upload.path}?digest=${digest}`, {
      headers: { "content-type": "application/octet-stream", "content-range": "5-10" },
      data: second,
    });
    expect(completed.status()).toBe(201);
    expect(completed.headers()["docker-content-digest"]).toBe(digest);
    expect(completed.headers()["content-range"]).toBe("0-10");
    expect(completed.headers().range).toBe("0-10");

    const blob = await owner.ctx.get(`/${repo.mountPath}/resumable/blobs/${digest}`);
    expect(blob.status()).toBe(200);
    expect(Buffer.from(await blob.body()).toString("utf8")).toBe("hello world");

    const statusAfterCommit = await owner.ctx.get(upload.path);
    expect(statusAfterCommit.status()).toBe(404);
    expect((await statusAfterCommit.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");

    const patchAfterCommit = await owner.ctx.patch(upload.path, {
      headers: { "content-type": "application/octet-stream", "content-range": "11-11" },
      data: Buffer.from("!"),
    });
    expect(patchAfterCommit.status()).toBe(404);
    expect((await patchAfterCommit.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");

    const cancelAfterCommit = await owner.ctx.delete(upload.path);
    expect(cancelAfterCommit.status()).toBe(404);
    expect((await cancelAfterCommit.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");

    const expired = await startUpload(owner.ctx, repo.mountPath, "expired");
    expireUploadSession(expired.uuid);
    const expiredStatus = await owner.ctx.get(expired.path);
    expect(expiredStatus.status()).toBe(404);
    expect((await expiredStatus.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  test("resumable PATCH bytes count against org quota before staging", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "quota-patch-containers",
          moduleId: "docker",
        })
      ).json()
    ).repository as { mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxStorageBytes: 4 } });

    const upload = await startUpload(owner.ctx, repo.mountPath, "quota-patch");
    const rejected = await owner.ctx.patch(upload.path, {
      headers: { "content-type": "application/octet-stream", "content-range": "0-4" },
      data: Buffer.from("hello"),
    });
    expect(rejected.status()).toBe(403);
    expect((await rejected.json()).errors[0].code).toBe("DENIED");
    expect(uploadSessionState(upload.uuid)).toMatchObject({
      chunkExists: [],
      offsetBytes: 0,
      state: "open",
    });
  });

  test("expired abandoned OCI upload sessions are reaped without client access", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "reaped-containers",
          moduleId: "docker",
        })
      ).json()
    ).repository as { mountPath: string };

    const upload = await startUpload(owner.ctx, repo.mountPath, "abandoned");
    const chunk = Buffer.from("abandoned bytes");
    const patch = await owner.ctx.patch(upload.path, {
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `0-${chunk.length - 1}`,
      },
      data: chunk,
    });
    expect(patch.status()).toBe(202);
    expect(uploadSessionState(upload.uuid)).toMatchObject({
      chunkExists: [true],
      offsetBytes: chunk.length,
      state: "open",
    });

    expireUploadSession(upload.uuid);
    expect(reapExpiredUploadSessions()).toEqual({ aborted: 1 });
    expect(uploadSessionState(upload.uuid)).toMatchObject({
      chunkExists: [false],
      state: "aborted",
      storageExists: false,
    });

    const status = await owner.ctx.get(upload.path);
    expect(status.status()).toBe(404);
    expect((await status.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  test("quota-rejected resumable upload does not leave orphaned CAS bytes", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "quota-containers", moduleId: "docker" })
      ).json()
    ).repository as { mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxStorageBytes: 1 } });

    const bytes = Buffer.from("stream quota rollback payload");
    const digest = sha256(bytes);
    const upload = await startUpload(owner.ctx, repo.mountPath, "quota");
    const rejected = await owner.ctx.put(`${upload.path}?digest=${digest}`, {
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `0-${bytes.length - 1}`,
      },
      data: bytes,
    });
    expect(rejected.status()).toBe(403);
    expect(casBlobState(digest)).toEqual({ dbRows: 0, exists: false });
  });
});

test.describe("docker registry connection & streaming transport", () => {
  async function dockerRepo(owner: Awaited<ReturnType<typeof setupOwner>>, name: string) {
    const res = await createRepo(owner.ctx, owner.orgId, { name, moduleId: "docker" });
    expect(res.status()).toBe(201);
    return ((await res.json()).repository as { mountPath: string }).mountPath;
  }

  async function patchChunk(
    ctx: APIRequestContext,
    path: string,
    start: number,
    chunk: Buffer,
  ): Promise<Awaited<ReturnType<APIRequestContext["patch"]>>> {
    return ctx.patch(path, {
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `${start}-${start + chunk.length - 1}`,
      },
      data: chunk,
    });
  }

  test("cross-repository blob mount links a blob without re-upload and charges storage once", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const sourceMount = await dockerRepo(owner, "mount-source");
    const targetMount = await dockerRepo(owner, "mount-target");

    const bytes = Buffer.from("cross-repo-mount-layer-payload-0123456789");
    const digest = await uploadBlob(owner.ctx, sourceMount, "app", bytes);
    const fromRef = `${sourceMount.replace(/^v2\//, "")}/app`;

    // Mounting an existing blob from a readable repo links it without re-upload.
    const mounted = await owner.ctx.post(
      `/${targetMount}/app/blobs/uploads?mount=${digest}&from=${encodeURIComponent(fromRef)}`,
    );
    expect(mounted.status()).toBe(201);
    expect(mounted.headers()["docker-content-digest"]).toBe(digest);
    expect(mounted.headers().location).toContain(`/${targetMount}/app/blobs/${digest}`);

    // The blob is immediately readable from the target without ever being re-sent.
    const got = await owner.ctx.get(`/${targetMount}/app/blobs/${digest}`);
    expect(got.status()).toBe(200);
    expect(Buffer.from(await got.body())).toEqual(bytes);

    // Dedup: both references point at a single physical CAS object.
    expect(casBlobState(digest)).toEqual({ dbRows: 1, exists: true });

    // A mount whose `from` matches no readable source falls back to a fresh
    // resumable upload session (202 + an uploads Location) rather than 201.
    const fallback = await owner.ctx.post(
      `/${targetMount}/app/blobs/uploads?mount=${digest}&from=${encodeURIComponent("no/such/source")}`,
    );
    expect(fallback.status()).toBe(202);
    expect(fallback.headers().location).toContain(`/${targetMount}/app/blobs/uploads/`);
  });

  test("out-of-order and overlapping resumable PATCH chunks are rejected and the session recovers", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "chunk-order");
    const upload = await startUpload(owner.ctx, mount, "chunked");

    const accepted = await patchChunk(owner.ctx, upload.path, 0, Buffer.from("hello"));
    expect(accepted.status()).toBe(202);
    expect(accepted.headers().range).toBe("0-4");

    // Forward gap: start (8) is past the committed offset (5).
    const gap = await patchChunk(owner.ctx, upload.path, 8, Buffer.from("world"));
    expect(gap.status()).toBe(416);
    expect((await gap.json()).errors[0].code).toBe("BLOB_UPLOAD_INVALID");
    expect((await owner.ctx.get(upload.path)).headers().range).toBe("0-4");

    // Overlap: start (2) is before the committed offset (5).
    const overlap = await patchChunk(owner.ctx, upload.path, 2, Buffer.from("XXXXX"));
    expect(overlap.status()).toBe(416);
    expect((await overlap.json()).errors[0].code).toBe("BLOB_UPLOAD_INVALID");
    const status = await owner.ctx.get(upload.path);
    expect(status.status()).toBe(204);
    expect(status.headers().range).toBe("0-4");

    // The next correctly-aligned chunk is accepted and the upload commits cleanly.
    const resumed = await patchChunk(owner.ctx, upload.path, 5, Buffer.from(" world"));
    expect(resumed.status()).toBe(202);
    expect(resumed.headers().range).toBe("0-10");

    const digest = sha256("hello world");
    const committed = await owner.ctx.put(`${upload.path}?digest=${digest}`);
    expect(committed.status()).toBe(201);
    expect(committed.headers()["docker-content-digest"]).toBe(digest);
    expect(
      Buffer.from(await (await owner.ctx.get(`/${mount}/chunked/blobs/${digest}`)).body()),
    ).toEqual(Buffer.from("hello world"));
  });

  test("a resumable upload can be cancelled with DELETE and the session is purged", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "cancel-upload");
    const upload = await startUpload(owner.ctx, mount, "cancelled");

    expect((await patchChunk(owner.ctx, upload.path, 0, Buffer.from("hello"))).status()).toBe(202);
    expect(uploadSessionState(upload.uuid)).toMatchObject({
      chunkExists: [true],
      offsetBytes: 5,
      state: "open",
    });

    const cancelled = await owner.ctx.delete(upload.path);
    expect(cancelled.status()).toBe(204);

    // The session row is gone and its staged bytes are purged.
    expect(uploadSessionState(upload.uuid).state).toBeNull();

    const status = await owner.ctx.get(upload.path);
    expect(status.status()).toBe(404);
    expect((await status.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");

    const patch = await patchChunk(owner.ctx, upload.path, 5, Buffer.from("!"));
    expect(patch.status()).toBe(404);
    expect((await patch.json()).errors[0].code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  test("monolithic and chunked uploads of the same bytes converge to one CAS object", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "upload-equivalence");
    const bytes = Buffer.from("monolithic-vs-chunked-equivalence-payload");
    const digest = sha256(bytes);

    // Path 1: a single monolithic POST ?digest upload.
    const monoDigest = await uploadBlob(owner.ctx, mount, "mono", bytes);
    expect(monoDigest).toBe(digest);

    // Path 2: a two-PATCH resumable upload of the identical bytes.
    const half = Math.floor(bytes.length / 2);
    const upload = await startUpload(owner.ctx, mount, "chunked");
    expect((await patchChunk(owner.ctx, upload.path, 0, bytes.subarray(0, half))).status()).toBe(
      202,
    );
    expect((await patchChunk(owner.ctx, upload.path, half, bytes.subarray(half))).status()).toBe(
      202,
    );
    const chunkedCommit = await owner.ctx.put(`${upload.path}?digest=${digest}`);
    expect(chunkedCommit.status()).toBe(201);
    expect(chunkedCommit.headers()["docker-content-digest"]).toBe(digest);

    // Both framings produced the same digest, both blobs read back identically,
    // and they share a single deduplicated CAS object.
    for (const image of ["mono", "chunked"]) {
      const blob = await owner.ctx.get(`/${mount}/${image}/blobs/${digest}`);
      expect(blob.status()).toBe(200);
      expect(Buffer.from(await blob.body())).toEqual(bytes);
    }
    expect(casBlobState(digest)).toEqual({ dbRows: 1, exists: true });
  });

  test("an empty final PUT commits a chunked upload whose bytes were fully sent via PATCH", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "empty-commit");
    const upload = await startUpload(owner.ctx, mount, "staged");

    expect((await patchChunk(owner.ctx, upload.path, 0, Buffer.from("hello"))).status()).toBe(202);
    expect((await patchChunk(owner.ctx, upload.path, 5, Buffer.from(" world"))).status()).toBe(202);

    // Commit with no trailing body — all bytes are already staged.
    const digest = sha256("hello world");
    const committed = await owner.ctx.put(`${upload.path}?digest=${digest}`);
    expect(committed.status()).toBe(201);
    expect(committed.headers()["docker-content-digest"]).toBe(digest);
    expect(committed.headers()["content-range"]).toBe("0-10");

    const blob = await owner.ctx.get(`/${mount}/staged/blobs/${digest}`);
    expect(Buffer.from(await blob.body()).toString("utf8")).toBe("hello world");
  });

  test("GET upload status reports the committed offset progressing across PATCH chunks", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "status-progress");
    const upload = await startUpload(owner.ctx, mount, "progress");

    const initial = await owner.ctx.get(upload.path);
    expect(initial.status()).toBe(204);
    expect(initial.headers().range).toBe("0-0");
    expect(initial.headers()["docker-upload-uuid"]).toBe(upload.uuid);

    const steps: [Buffer, number, string][] = [
      [Buffer.from("0123"), 0, "0-3"],
      [Buffer.from("456789"), 4, "0-9"],
      [Buffer.from("A"), 10, "0-10"],
    ];
    for (const [chunk, start, expectedRange] of steps) {
      expect((await patchChunk(owner.ctx, upload.path, start, chunk)).status()).toBe(202);
      const status = await owner.ctx.get(upload.path);
      expect(status.status()).toBe(204);
      expect(status.headers().range).toBe(expectedRange);
      expect(status.headers()["docker-upload-uuid"]).toBe(upload.uuid);
    }

    const digest = sha256("0123456789A");
    expect((await owner.ctx.put(`${upload.path}?digest=${digest}`)).status()).toBe(201);
  });

  test("manifest GET honors conditional If-None-Match and HEAD echoes the digest ETag", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "manifest-conditional");
    const configDigest = await uploadBlob(owner.ctx, mount, "img", Buffer.from("{}"));
    const layerDigest = await uploadBlob(owner.ctx, mount, "img", Buffer.from("layer-a"));
    const manifestDigest = await putManifest(
      owner.ctx,
      mount,
      "img",
      "v1",
      configDigest,
      layerDigest,
    );

    const accept = { accept: OCI_MEDIA_TYPES.manifestV1 };
    const url = `/${mount}/img/manifests/v1`;

    const get = await owner.ctx.get(url, { headers: accept });
    expect(get.status()).toBe(200);
    const etag = get.headers().etag;
    expect(etag).toBe(`"${manifestDigest}"`);
    expect(get.headers()["docker-content-digest"]).toBe(manifestDigest);

    const matched = await owner.ctx.get(url, { headers: { ...accept, "if-none-match": etag } });
    expect(matched.status()).toBe(304);
    expect(Buffer.from(await matched.body()).length).toBe(0);

    const wildcard = await owner.ctx.get(url, { headers: { ...accept, "if-none-match": "*" } });
    expect(wildcard.status()).toBe(304);

    const stale = await owner.ctx.get(url, {
      headers: { ...accept, "if-none-match": `"sha256:${"0".repeat(64)}"` },
    });
    expect(stale.status()).toBe(200);

    const head = await owner.ctx.head(url, { headers: accept });
    expect(head.status()).toBe(200);
    expect(head.headers().etag).toBe(etag);
    expect(head.headers()["docker-content-digest"]).toBe(manifestDigest);
  });

  test("aborting a blob download mid-stream leaves the server able to serve it again", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const mount = await dockerRepo(owner, "abortable");
    const bytes = Buffer.alloc(1 << 20, 0x61); // 1 MiB
    const digest = await uploadBlob(owner.ctx, mount, "big", bytes);
    const path = `/${mount}/big/blobs/${digest}`;

    // Several aborted reads (1 ms deadline) — each either throws or completes;
    // either way the source must be torn down without wedging the server.
    for (let i = 0; i < 3; i++) {
      await owner.ctx.get(path, { timeout: 1 }).catch(() => {});
    }

    // A subsequent clean read still returns the full, correct blob.
    const clean = await owner.ctx.get(path);
    expect(clean.status()).toBe(200);
    const body = Buffer.from(await clean.body());
    expect(body.length).toBe(bytes.length);
    expect(sha256(body)).toBe(digest);
  });
});
