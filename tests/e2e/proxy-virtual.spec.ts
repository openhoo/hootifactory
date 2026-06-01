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

function publishSucceeds(
  baseURL: string,
  mountPath: string,
  token: string,
  pkgName: string,
): boolean {
  try {
    publish(baseURL, mountPath, token, pkgName);
    return true;
  } catch {
    return false;
  }
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

async function pollArtifact(
  ctx: Awaited<ReturnType<typeof setupOwner>>["ctx"],
  repoId: string,
  name: string,
  timeoutMs = 60_000,
): Promise<{ id: string; name: string; version: string | null; state: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.get(`/api/repositories/${repoId}/artifacts`);
    const body = (await res.json()) as {
      artifacts: { id: string; name: string; version: string | null; state: string }[];
    };
    const found = body.artifacts.find((a) => a.name === name);
    if (found && found.state !== "pending") return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`artifact ${name} was not scanned within ${timeoutMs}ms`);
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
    expect(publishSucceeds(baseURL!, proxy.mountPath, token, `proxywrite${pkg}`)).toBe(false);
    publish(baseURL!, upstream.mountPath, token, pkg);

    const directTarballBeforeIngest = await owner.ctx.get(
      `/${proxy.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`,
    );
    expect(directTarballBeforeIngest.status()).toBe(404);

    const dir = installAll(baseURL!, proxy.mountPath, token, [`${pkg}@1.0.0`]);
    expect(existsSync(join(dir, "node_modules", pkg, "index.js"))).toBe(true);

    const localTarballAfterIngest = await owner.ctx.get(
      `/${proxy.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`,
    );
    expect(localTarballAfterIngest.status()).toBe(200);
  });

  test("proxy-mirrored packages are recorded and scanned locally", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const upstream = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-scan-up",
          format: "npm",
          visibility: "public",
        }),
      )
    ).repository;
    const proxyName = "npm-proxy-scan";
    const proxy = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: proxyName,
          format: "npm",
          kind: "proxy",
        }),
      )
    ).repository;
    await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
      data: { url: `${baseURL}/${upstream.mountPath}/` },
    });
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: proxyName, mode: "audit", blockOnSeverity: "high" },
    });

    const pkg = `proxyscan${Date.now().toString(36)}`;
    publish(baseURL!, upstream.mountPath, token, pkg);

    const packument = await owner.ctx.get(`/${proxy.mountPath}/${pkg}`);
    expect(packument.status()).toBe(200);

    const artifact = await pollArtifact(owner.ctx, proxy.id, pkg);
    expect(artifact.version).toBe("1.0.0");
    expect(artifact.state).toBe("clean");
  });

  test("configuration rejects invalid virtual and proxy topology", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const other = await setupOwner(baseURL!);
    const hosted = (
      await repoFrom(await createRepo(owner.ctx, owner.orgId, { name: "top-host", format: "npm" }))
    ).repository;
    const goHosted = (
      await repoFrom(await createRepo(owner.ctx, owner.orgId, { name: "top-go", format: "go" }))
    ).repository;
    const proxy = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "top-proxy",
          format: "npm",
          kind: "proxy",
        }),
      )
    ).repository;
    const virtual = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "top-virtual",
          format: "npm",
          kind: "virtual",
        }),
      )
    ).repository;
    const privateOther = (
      await repoFrom(
        await createRepo(other.ctx, other.orgId, { name: "top-private", format: "npm" }),
      )
    ).repository;

    expect(
      (
        await owner.ctx.post(`/api/repositories/${hosted.id}/members`, {
          data: { memberRepoId: hosted.id },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${hosted.id}/upstreams`, {
          data: { url: "https://registry.npmjs.org/" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/upstreams`, {
          data: { url: "https://registry.npmjs.org/" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: virtual.id },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: goHosted.id },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: proxy.id },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: privateOther.id },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: hosted.id, position: "first" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
          data: { url: "https://registry.npmjs.org/", priority: "first" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: hosted.id, position: 0 },
        })
      ).status(),
    ).toBe(201);
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
