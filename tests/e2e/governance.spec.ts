import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

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
  const registry = `${baseURL}/${mountPath}/`;
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
    execFileSync("npm", ["publish", "--registry", registry], {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "npmc-")) },
    });
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

test.describe("governance: quotas + retention", () => {
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

    const before = await (await owner.ctx.get(`/${repo.mountPath}/${pkg}`)).json();
    expect(Object.keys(before.versions)).toHaveLength(3);

    const applied = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 2 },
      })
    ).json();
    expect(applied.pruned).toBe(1);

    const after = await (await owner.ctx.get(`/${repo.mountPath}/${pkg}`)).json();
    expect(Object.keys(after.versions)).toHaveLength(2);
    expect(after.versions["1.0.0"]).toBeUndefined();
  });
});
