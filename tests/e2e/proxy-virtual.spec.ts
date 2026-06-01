import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

function npm(args: string[], cwd: string): void {
  try {
    execFileSync("npm", args, {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "npmc-")) },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`npm ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

function npmrc(registry: string, token: string): string {
  return `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`;
}

function publish(baseURL: string, mountPath: string, token: string, pkgName: string): void {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkgName, version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(join(dir, "index.js"), `module.exports = ${JSON.stringify(pkgName)};\n`);
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  npm(["publish", "--registry", registry], dir);
}

function installAll(baseURL: string, mountPath: string, token: string, specs: string[]): string {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "ins-"));
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  npm(["install", ...specs, "--registry", registry, "--no-audit", "--no-fund"], dir);
  return dir;
}

async function repoFrom(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as { repository: { id: string; mountPath: string } };
}

test.describe("virtual + proxy repositories (real npm)", () => {
  test("virtual repo aggregates two member repos", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const a = (
      await repoFrom(await createRepo(owner.ctx, owner.orgId, { name: "npm-a", format: "npm" }))
    ).repository;
    const b = (
      await repoFrom(await createRepo(owner.ctx, owner.orgId, { name: "npm-b", format: "npm" }))
    ).repository;
    const v = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-virt",
          format: "npm",
          kind: "virtual",
        }),
      )
    ).repository;
    await owner.ctx.post(`/api/repositories/${v.id}/members`, {
      data: { memberRepoId: a.id, position: 0 },
    });
    await owner.ctx.post(`/api/repositories/${v.id}/members`, {
      data: { memberRepoId: b.id, position: 1 },
    });

    const id = Date.now().toString(36);
    const pkgA = `pa${id}`;
    const pkgB = `pb${id}`;
    publish(baseURL!, a.mountPath, token, pkgA);
    publish(baseURL!, b.mountPath, token, pkgB);

    const dir = installAll(baseURL!, v.mountPath, token, [`${pkgA}@1.0.0`, `${pkgB}@1.0.0`]);
    expect(existsSync(join(dir, "node_modules", pkgA, "index.js"))).toBe(true);
    expect(existsSync(join(dir, "node_modules", pkgB, "index.js"))).toBe(true);
  });

  test("proxy repo mirrors a package from its upstream", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const upstream = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-up",
          format: "npm",
          visibility: "public",
        }),
      )
    ).repository;
    const proxy = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-proxy",
          format: "npm",
          kind: "proxy",
        }),
      )
    ).repository;
    await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
      data: { url: `${baseURL}/${upstream.mountPath}/` },
    });

    const pkg = `up${Date.now().toString(36)}`;
    publish(baseURL!, upstream.mountPath, token, pkg);

    const dir = installAll(baseURL!, proxy.mountPath, token, [`${pkg}@1.0.0`]);
    expect(existsSync(join(dir, "node_modules", pkg, "index.js"))).toBe(true);
  });
});

test.describe("virtual repositories with throwing adapters", () => {
  test("go virtual repo continues past a missing first member", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const a = (
      await repoFrom(await createRepo(owner.ctx, owner.orgId, { name: "go-a", format: "go" }))
    ).repository;
    const b = (
      await repoFrom(await createRepo(owner.ctx, owner.orgId, { name: "go-b", format: "go" }))
    ).repository;
    const v = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "go-virt",
          format: "go",
          kind: "virtual",
        }),
      )
    ).repository;
    await owner.ctx.post(`/api/repositories/${v.id}/members`, {
      data: { memberRepoId: a.id, position: 0 },
    });
    await owner.ctx.post(`/api/repositories/${v.id}/members`, {
      data: { memberRepoId: b.id, position: 1 },
    });

    const moduleName = `hoot.test/virt${Date.now().toString(36)}`;
    const version = "v1.0.0";
    const up = await owner.ctx.put(`/${b.mountPath}/${moduleName}/@v/${version}`, {
      multipart: {
        mod: `module ${moduleName}\n\ngo 1.20\n`,
        zip: {
          name: "m.zip",
          mimeType: "application/zip",
          buffer: Buffer.from("zip"),
        },
      },
    });
    expect(up.status()).toBe(200);

    const list = await owner.ctx.get(`/${v.mountPath}/${moduleName}/@v/list`);
    expect(list.status()).toBe(200);
    expect((await list.text()).trim()).toBe(version);
  });
});
