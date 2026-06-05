import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

function composer(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.composer, args, { cwd, env, entrypoint: "composer" });
}

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Minimal STORE-method (uncompressed) zip; Composer extracts it via its zip handler. */
function makeStoreZip(entries: { name: string; data: Uint8Array }[]): Buffer {
  const locals: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = [...new TextEncoder().encode(entry.name)];
    const data = [...entry.data];
    const size = data.length;
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...data,
    ];
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    );
    locals.push(...local);
    offset += local.length;
  }
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ];
  return Buffer.from([...locals, ...central, ...eocd]);
}

test.describe("composer registry (Dockerized real composer)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("upload -> composer install round-trips via the v2 metadata + dist", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "composer-cli",
      moduleId: "composer",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const name = `hoot/widget${id}`;
    const zip = makeStoreZip([
      { name: "composer.json", data: new TextEncoder().encode(JSON.stringify({ name })) },
      { name: "src/Widget.php", data: new TextEncoder().encode("<?php\nclass Widget {}\n") },
    ]);

    // Custom publish: PUT the dist zip + ?version (Composer has no native publish).
    const put = await owner.ctx.put(`/${repo.mountPath}/packages/${name}?version=1.0.0`, {
      data: zip,
      headers: { "content-type": "application/zip" },
    });
    expect(put.status()).toBe(201);

    const meta = await owner.ctx.get(`/${repo.mountPath}/p2/${name}.json`);
    expect(meta.status()).toBe(200);
    const metaDoc = await meta.json();
    expect(metaDoc.packages[name][0].version).toBe("1.0.0");
    expect(metaDoc.packages[name][0].dist.url).toContain(`/dist/${name}/1.0.0.zip`);

    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const consumer = mkdtempSync(join(tmpdir(), "hoot-composer-"));
    writeFileSync(
      join(consumer, "composer.json"),
      JSON.stringify({
        repositories: [{ type: "composer", url: repoUrl }, { "packagist.org": false }],
        require: { [name]: "1.0.0" },
        config: { "secure-http": false },
        "minimum-stability": "stable",
      }),
    );
    composer(["install", "--no-interaction", "--no-progress", "--prefer-dist"], consumer, {
      HOME: consumer,
      COMPOSER_HOME: join(consumer, ".composer"),
    });
    expect(existsSync(join(consumer, "vendor", "hoot", `widget${id}`, "composer.json"))).toBe(true);
  });
});
