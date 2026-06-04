import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";
import { dockerNpm, dockerReachableUrl, ensureDockerAvailable } from "./docker-clients";
import { createRepo, createToken, setupOwner, uniq } from "./helpers";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function publish(
  baseURL: string,
  mountPath: string,
  token: string,
  pkgName: string,
  version: string,
): { ok: boolean } {
  const registry = `${dockerReachableUrl(baseURL)}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkgName, version, main: "index.js" }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  writeFileSync(
    join(dir, ".npmrc"),
    `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`,
  );
  try {
    dockerNpm(["publish", "--registry", registry], dir);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function uploadOciBlob(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  bytes: Buffer,
): Promise<APIResponse> {
  const digest = sha256(bytes);
  return ctx.post(`/${mountPath}/${image}/blobs/uploads?digest=${digest}`, {
    headers: { "content-type": "application/octet-stream" },
    data: bytes,
  });
}

async function putOciManifest(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  configDigest: string,
  layerDigest: string,
  layerSize: number,
): Promise<APIResponse> {
  const raw = JSON.stringify({
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
        size: layerSize,
      },
    ],
  });
  return ctx.put(`/${mountPath}/${image}/manifests/${tag}`, {
    headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
    data: raw,
  });
}

test.describe("governance: quotas + retention", () => {
  test.beforeAll(ensureDockerAvailable);

  test("storage quota rejects malformed limits", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    for (const data of [
      { maxStorageBytes: -1 },
      { maxStorageBytes: 1.5 },
      { maxStorageBytes: "1000" },
    ]) {
      const res = await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data });
      expect(res.status()).toBe(400);
    }

    const unset = await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, {
      data: { maxStorageBytes: null },
    });
    expect(unset.status()).toBe(200);
    const quota = await (await owner.ctx.get(`/api/orgs/${owner.orgId}/quota`)).json();
    expect(quota.maxStorageBytes).toBeNull();
  });

  test("storage quota blocks publishes over the limit", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: "quota-npm", format: "npm" })).json()
    ).repository as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const id = Date.now().toString(36);

    // tiny quota -> publish rejected
    await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxStorageBytes: 10 } });
    expect(publish(baseURL!, repo.mountPath, token, `qp${id}a`, "1.0.0").ok).toBe(false);

    // generous quota -> publish succeeds; usage is tracked
    await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, {
      data: { maxStorageBytes: 100_000_000 },
    });
    expect(publish(baseURL!, repo.mountPath, token, `qp${id}b`, "1.0.0").ok).toBe(true);

    const quota = await (await owner.ctx.get(`/api/orgs/${owner.orgId}/quota`)).json();
    expect(quota.usedStorageBytes).toBeGreaterThan(0);
  });

  test("storage quota is charged per org even when CAS bytes dedupe globally", async ({
    baseURL,
  }) => {
    const first = await setupOwner(baseURL!);
    const second = await setupOwner(baseURL!);
    const firstRepo = (
      await (
        await createRepo(first.ctx, first.orgId, { name: "quota-oci", format: "docker" })
      ).json()
    ).repository as { mountPath: string };
    const secondRepo = (
      await (
        await createRepo(second.ctx, second.orgId, { name: "quota-oci", format: "docker" })
      ).json()
    ).repository as { mountPath: string };
    const bytes = Buffer.from("shared quota payload that is larger than ten bytes");

    const firstUpload = await uploadOciBlob(first.ctx, firstRepo.mountPath, "app", bytes);
    expect(firstUpload.status()).toBe(201);

    await second.ctx.post(`/api/orgs/${second.orgId}/quota`, { data: { maxStorageBytes: 10 } });
    const blocked = await uploadOciBlob(second.ctx, secondRepo.mountPath, "app", bytes);
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).errors[0].message).toBe("storage quota exceeded");

    await second.ctx.post(`/api/orgs/${second.orgId}/quota`, {
      data: { maxStorageBytes: 1_000_000 },
    });
    const allowed = await uploadOciBlob(second.ctx, secondRepo.mountPath, "app", bytes);
    expect(allowed.status()).toBe(201);

    const quota = await (await second.ctx.get(`/api/orgs/${second.orgId}/quota`)).json();
    expect(quota.usedStorageBytes).toBe(bytes.byteLength);
  });

  test("storage quota blocks cross-org OCI blob mounts before adding a target ref", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const targetSlug = uniq("target-org");
    const targetOrgRes = await owner.ctx.post("/api/orgs", {
      data: { slug: targetSlug, displayName: `Org ${targetSlug}` },
    });
    expect(targetOrgRes.status()).toBe(201);
    const targetOrg = (await targetOrgRes.json()).org as { id: string };
    const sourceRepoName = uniq("source-oci");
    const targetRepoName = uniq("target-oci");
    const sourceRepo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: sourceRepoName, format: "docker" })
      ).json()
    ).repository as { mountPath: string };
    const targetRepo = (
      await (
        await createRepo(owner.ctx, targetOrg.id, { name: targetRepoName, format: "docker" })
      ).json()
    ).repository as { mountPath: string };
    const bytes = Buffer.from("mounted payload that must be charged to target org");
    const digest = sha256(bytes);

    const sourceUpload = await uploadOciBlob(owner.ctx, sourceRepo.mountPath, "app", bytes);
    expect(sourceUpload.status()).toBe(201);
    expect(sourceUpload.headers()["docker-content-digest"]).toBe(digest);

    const mountFrom = `${sourceRepo.mountPath.replace(/^v2\//, "")}/app`;
    const mountUrl = `/${targetRepo.mountPath}/app/blobs/uploads?mount=${encodeURIComponent(
      digest,
    )}&from=${encodeURIComponent(mountFrom)}`;

    await owner.ctx.post(`/api/orgs/${targetOrg.id}/quota`, { data: { maxStorageBytes: 10 } });
    const blocked = await owner.ctx.post(mountUrl);
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).errors[0].message).toBe("storage quota exceeded");

    await owner.ctx.post(`/api/orgs/${targetOrg.id}/quota`, {
      data: { maxStorageBytes: 1_000_000 },
    });
    const allowed = await owner.ctx.post(mountUrl);
    expect(allowed.status()).toBe(201);
    expect(allowed.headers()["docker-content-digest"]).toBe(digest);

    const quota = await (await owner.ctx.get(`/api/orgs/${targetOrg.id}/quota`)).json();
    expect(quota.usedStorageBytes).toBe(bytes.byteLength);

    const mountedBlob = await owner.ctx.get(`/${targetRepo.mountPath}/app/blobs/${digest}`);
    expect(mountedBlob.status()).toBe(200);
    expect(Buffer.from(await mountedBlob.body()).equals(bytes)).toBe(true);
  });

  test("retention prunes old versions", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repoRes = await (
      await createRepo(owner.ctx, owner.orgId, { name: "ret-npm", format: "npm" })
    ).json();
    const repo = repoRes.repository as { id: string; mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const pkg = `retpkg${Date.now().toString(36)}`;

    for (const v of ["1.0.0", "1.0.1", "1.0.2"]) {
      expect(publish(baseURL!, repo.mountPath, token, pkg, v).ok).toBe(true);
    }

    for (const tag of ["latest", "beta"]) {
      const tagRes = await owner.ctx.put(`/${repo.mountPath}/-/package/${pkg}/dist-tags/${tag}`, {
        data: `"1.0.0"`,
      });
      expect(tagRes.status()).toBe(200);
    }

    const before = await (await owner.ctx.get(`/${repo.mountPath}/${pkg}`)).json();
    expect(Object.keys(before.versions)).toHaveLength(3);
    expect(before["dist-tags"].latest).toBe("1.0.0");
    expect(before["dist-tags"].beta).toBe("1.0.0");
    expect((await owner.ctx.head(`/${repo.mountPath}/${pkg}`)).status()).toBe(200);
    expect((await owner.ctx.head(`/${repo.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`)).status()).toBe(
      200,
    );

    const invalid = await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
      data: { keepLastN: 0 },
    });
    expect(invalid.status()).toBe(400);

    const applied = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 2 },
      })
    ).json();
    expect(applied.pruned).toBe(1);

    const after = await (await owner.ctx.get(`/${repo.mountPath}/${pkg}`)).json();
    expect(Object.keys(after.versions)).toHaveLength(2);
    expect(after.versions["1.0.0"]).toBeUndefined();
    expect(after["dist-tags"].latest).toBe("1.0.2");
    expect(after["dist-tags"].beta).toBeUndefined();

    const listedTags = await (
      await owner.ctx.get(`/${repo.mountPath}/-/package/${pkg}/dist-tags`)
    ).json();
    expect(listedTags).toEqual({ latest: "1.0.2" });

    const packagesRes = await owner.ctx.get(`/api/repositories/${repo.id}/packages`);
    const packagesBody = (await packagesRes.json()) as {
      packages: { id: string; name: string; latestVersion: string | null }[];
    };
    const listed = packagesBody.packages.find((p) => p.name === pkg);
    expect(listed?.latestVersion).toBe("1.0.2");

    const versionsRes = await owner.ctx.get(`/api/packages/${listed!.id}/versions`);
    const versionsBody = (await versionsRes.json()) as { versions: { version: string }[] };
    expect(versionsBody.versions.map((v) => v.version).sort()).toEqual(["1.0.1", "1.0.2"]);
    expect(publish(baseURL!, repo.mountPath, token, pkg, "1.0.0").ok).toBe(false);
  });

  test("artifact quota charges OCI version reactivation after retention", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: uniq("quota-oci-retention"),
          format: "docker",
        })
      ).json()
    ).repository as { id: string; mountPath: string };
    const image = uniq("quota-reactivation");
    const config = Buffer.from("{}");
    const layer = Buffer.from("quota reactivation layer");
    const configDigest = sha256(config);
    const layerDigest = sha256(layer);
    const quotaState = async (): Promise<{ usedArtifacts: number }> => {
      const res = await owner.ctx.get(`/api/v1/orgs/${owner.orgId}/quota`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { data: { usedArtifacts: number } }).data;
    };

    expect((await uploadOciBlob(owner.ctx, repo.mountPath, image, config)).status()).toBe(201);
    expect((await uploadOciBlob(owner.ctx, repo.mountPath, image, layer)).status()).toBe(201);
    await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxArtifacts: 2 } });

    for (const tag of ["v1", "v2"]) {
      expect(
        (
          await putOciManifest(
            owner.ctx,
            repo.mountPath,
            image,
            tag,
            configDigest,
            layerDigest,
            layer.byteLength,
          )
        ).status(),
      ).toBe(201);
    }
    expect((await quotaState()).usedArtifacts).toBe(2);

    const applied = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 1 },
      })
    ).json();
    expect(applied.pruned).toBe(1);
    expect((await quotaState()).usedArtifacts).toBe(1);

    const packagesRes = await owner.ctx.get(`/api/repositories/${repo.id}/packages`);
    const packagesBody = (await packagesRes.json()) as {
      packages: { id: string; name: string }[];
    };
    const pkg = packagesBody.packages.find((row) => row.name === image);
    expect(pkg).toBeTruthy();
    const versionsRes = await owner.ctx.get(`/api/packages/${pkg!.id}/versions`);
    const versionsBody = (await versionsRes.json()) as {
      versions: { version: string }[];
    };
    const liveVersions = new Set(versionsBody.versions.map((version) => version.version));
    const prunedTag = ["v1", "v2"].find((tag) => !liveVersions.has(tag));
    expect(prunedTag).toBeTruthy();

    expect(
      (
        await putOciManifest(
          owner.ctx,
          repo.mountPath,
          image,
          prunedTag!,
          configDigest,
          layerDigest,
          layer.byteLength,
        )
      ).status(),
    ).toBe(201);
    expect((await quotaState()).usedArtifacts).toBe(2);

    const blocked = await putOciManifest(
      owner.ctx,
      repo.mountPath,
      image,
      "v3",
      configDigest,
      layerDigest,
      layer.byteLength,
    );
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).errors[0].message).toBe("storage quota exceeded");
  });

  test("artifact quota credits OCI manifest digest deletes", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: uniq("quota-oci-delete"),
          format: "docker",
        })
      ).json()
    ).repository as { mountPath: string };
    const image = uniq("quota-delete");
    const config = Buffer.from("{}");
    const layer = Buffer.from("quota delete layer");
    const configDigest = sha256(config);
    const layerDigest = sha256(layer);
    const quotaState = async (): Promise<{ usedArtifacts: number }> => {
      const res = await owner.ctx.get(`/api/v1/orgs/${owner.orgId}/quota`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { data: { usedArtifacts: number } }).data;
    };

    expect((await uploadOciBlob(owner.ctx, repo.mountPath, image, config)).status()).toBe(201);
    expect((await uploadOciBlob(owner.ctx, repo.mountPath, image, layer)).status()).toBe(201);
    await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxArtifacts: 1 } });

    const pushed = await putOciManifest(
      owner.ctx,
      repo.mountPath,
      image,
      "v1",
      configDigest,
      layerDigest,
      layer.byteLength,
    );
    expect(pushed.status()).toBe(201);
    const digest = pushed.headers()["docker-content-digest"];
    expect(digest).toMatch(/^sha256:/);
    expect((await quotaState()).usedArtifacts).toBe(1);

    const deleted = await owner.ctx.delete(`/${repo.mountPath}/${image}/manifests/${digest}`);
    expect(deleted.status()).toBe(202);
    expect((await quotaState()).usedArtifacts).toBe(0);

    expect((await uploadOciBlob(owner.ctx, repo.mountPath, image, config)).status()).toBe(201);
    expect((await uploadOciBlob(owner.ctx, repo.mountPath, image, layer)).status()).toBe(201);
    const secondPush = await putOciManifest(
      owner.ctx,
      repo.mountPath,
      image,
      "v2",
      configDigest,
      layerDigest,
      layer.byteLength,
    );
    expect(secondPush.status()).toBe(201);
    expect((await quotaState()).usedArtifacts).toBe(1);
  });
});
