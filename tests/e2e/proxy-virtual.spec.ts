import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dockerNpm, dockerReachableUrl, ensureDockerAvailable } from "./docker-clients";
import { createRepo, createToken, setupOwner } from "./helpers";

function npm(args: string[], cwd: string): void {
  dockerNpm(args, cwd);
}

function npmrc(registry: string, token: string): string {
  return `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`;
}

function publish(baseURL: string, mountPath: string, token: string, pkgName: string): void {
  const registry = `${dockerReachableUrl(baseURL)}/${mountPath}/`;
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
  const registry = `${dockerReachableUrl(baseURL)}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "ins-"));
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  npm(["install", ...specs, "--registry", registry, "--no-audit", "--no-fund"], dir);
  return dir;
}

async function repoFrom(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as { repository: { id: string; mountPath: string } };
}

function sha1hex(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function startNpmUpstream(input: {
  name: string;
  advertisedBytes: Buffer;
  includeHashes?: boolean;
  redirectTarballTo?: string;
  servedBytes: Buffer;
}): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "/");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const tarballPath = `/${input.name}/-/${input.name}-1.0.0.tgz`;
    if (url.pathname === `/${input.name}`) {
      const base = `http://${req.headers.host}`;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: input.name,
          versions: {
            "1.0.0": {
              name: input.name,
              version: "1.0.0",
              dist:
                input.includeHashes === false
                  ? { tarball: `${base}${tarballPath}` }
                  : {
                      tarball: `${base}${tarballPath}`,
                      shasum: sha1hex(input.advertisedBytes),
                      integrity: sha512Integrity(input.advertisedBytes),
                    },
            },
          },
          "dist-tags": { latest: "1.0.0" },
        }),
      );
      return;
    }
    if (url.pathname === tarballPath) {
      if (input.redirectTarballTo) {
        res.statusCode = 302;
        res.setHeader("location", input.redirectTarballTo);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/octet-stream");
      res.end(input.servedBytes);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
  };
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function createGoModuleZip(moduleName: string, version: string): Buffer {
  return createStoredZip([
    {
      name: `${moduleName}@${version}/go.mod`,
      data: `module ${moduleName}\n\ngo 1.20\n`,
    },
    {
      name: `${moduleName}@${version}/lib.go`,
      data: 'package lib\n\nconst Marker = "virtual"\n',
    },
  ]);
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

test.describe("virtual + proxy repositories (Dockerized real npm)", () => {
  test.beforeAll(ensureDockerAvailable);

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

  test("proxy repo rejects upstream tarballs that do not match advertised integrity", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const proxy = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-proxy-integrity",
          format: "npm",
          kind: "proxy",
        }),
      )
    ).repository;
    const pkg = `badintegrity${Date.now().toString(36)}`;
    const upstream = await startNpmUpstream({
      name: pkg,
      advertisedBytes: Buffer.from("honest tarball"),
      servedBytes: Buffer.from("tampered tarball"),
    });
    try {
      await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
        data: { url: `${upstream.url}/` },
      });

      const packument = await owner.ctx.get(`/${proxy.mountPath}/${pkg}`);
      expect(packument.status()).toBe(404);

      const tarball = await owner.ctx.get(`/${proxy.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
      expect(tarball.status()).toBe(404);
    } finally {
      await upstream.close();
    }
  });

  test("proxy repo rejects unverifiable tarballs and path-shaped package names", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const proxy = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-proxy-unverified",
          format: "npm",
          kind: "proxy",
        }),
      )
    ).repository;
    const pkg = `nohash${Date.now().toString(36)}`;
    const upstream = await startNpmUpstream({
      name: pkg,
      advertisedBytes: Buffer.from("unhashed tarball"),
      servedBytes: Buffer.from("unhashed tarball"),
      includeHashes: false,
    });
    try {
      await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
        data: { url: `${upstream.url}/` },
      });

      const packument = await owner.ctx.get(`/${proxy.mountPath}/${pkg}`);
      expect(packument.status()).toBe(404);

      const traversing = await owner.ctx.get(`/${proxy.mountPath}/bad%2fname`);
      expect(traversing.status()).toBe(400);
      expect(upstream.requests).not.toContain("/bad%2Fname");
    } finally {
      await upstream.close();
    }
  });

  test("proxy repo rejects tarball redirects away from the configured upstream host", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const proxy = (
      await repoFrom(
        await createRepo(owner.ctx, owner.orgId, {
          name: "npm-proxy-redirect",
          format: "npm",
          kind: "proxy",
        }),
      )
    ).repository;
    const pkg = `redirectpkg${Date.now().toString(36)}`;
    const bytes = Buffer.from("redirected tarball");
    const redirected = await startNpmUpstream({
      name: `${pkg}-redirected`,
      advertisedBytes: bytes,
      servedBytes: bytes,
    });
    const upstream = await startNpmUpstream({
      name: pkg,
      advertisedBytes: bytes,
      servedBytes: bytes,
      redirectTarballTo: `${redirected.url}/${pkg}-redirected/-/${pkg}-redirected-1.0.0.tgz`,
    });
    try {
      await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
        data: { url: `${upstream.url}/` },
      });

      const packument = await owner.ctx.get(`/${proxy.mountPath}/${pkg}`);
      expect(packument.status()).toBe(404);
      expect(redirected.requests).toEqual([]);
    } finally {
      await upstream.close();
      await redirected.close();
    }
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
          buffer: createGoModuleZip(moduleName, version),
        },
      },
    });
    expect(up.status()).toBe(200);

    const list = await owner.ctx.get(`/${v.mountPath}/${moduleName}/@v/list`);
    expect(list.status()).toBe(200);
    expect((await list.text()).trim()).toBe(version);
  });
});
