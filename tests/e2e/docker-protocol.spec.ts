import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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
  format: "npm";
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
        "  format: process.env.FORMAT,",
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
        FORMAT: input.format,
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

test.describe("docker registry protocol authorization", () => {
  test("OCI bearer JWTs cannot authorize non-OCI repository formats", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "containers", format: "docker" })).status(),
    ).toBe(201);
    const imageName = `${owner.orgSlug}/containers/app`;
    const legacyMount = `npm/${owner.orgSlug}/${imageName}`;
    insertLegacyRepository({
      orgId: owner.orgId,
      name: imageName,
      format: "npm",
      mountPath: legacyMount,
      storagePrefix: `${owner.orgId}/legacy-cross-format`,
    });

    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "oci-reader",
          scopes: [{ repository: imageName, actions: ["read"] }],
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
        await createRepo(owner.ctx, owner.orgId, { name: "containers", format: "docker" })
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
          scopes: [{ repository: "containers", actions: ["read"] }],
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
    expect(repoNameOnlyManifest.status()).toBe(403);

    const appSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "app-reader",
          scopes: [{ repository: `${owner.orgSlug}/containers/app`, actions: ["read"] }],
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
          scopes: [{ repository: `${owner.orgSlug}/containers/other`, actions: ["read"] }],
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
          scopes: [
            { repository: `${owner.orgSlug}/containers/other`, actions: ["read", "delete"] },
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
});
