import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

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
