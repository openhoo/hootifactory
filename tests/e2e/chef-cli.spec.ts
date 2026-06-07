import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import {
  builtClientImage,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
} from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// `knife supermarket share` (publish) signs requests with Chef's X-Ops RSA
// protocol our adapter does not implement, so we publish over raw HTTP multipart
// and consume with the real `knife supermarket download/list` client.
function knife(args: string[], cwd: string): string {
  return dockerRun(builtClientImage("chef"), ["knife", ...args], { cwd, env: { HOME: cwd } });
}

test.describe("chef supermarket registry (Dockerized real knife)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("HTTP multipart publish -> knife supermarket download round-trips", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "chef-cli",
      moduleId: "chef",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "chef" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const cookbook = `hootcb_${id}`; // [a-z0-9_-]+
    const version = "1.0.0";
    const tarball = gzipSync(Buffer.from(`hootifactory chef e2e ${id}\n`));

    // Publish via raw HTTP multipart (parts named exactly `cookbook` JSON + `tarball`).
    const publish = await owner.ctx.post(`/${repo.mountPath}/api/v1/cookbooks`, {
      headers: { authorization: `Basic ${Buffer.from(`__token__:${secret}`).toString("base64")}` },
      multipart: {
        cookbook: JSON.stringify({
          name: cookbook,
          version,
          description: "hootifactory chef e2e",
          maintainer: "e2e",
          license: "Apache-2.0",
          category: "Other",
        }),
        tarball: {
          name: `${cookbook}-${version}.tar.gz`,
          mimeType: "application/gzip",
          buffer: tarball,
        },
      },
    });
    expect(publish.status()).toBe(201);
    expect((await publish.json()).uri).toContain(`/api/v1/cookbooks/${cookbook}`);

    // Server-side: the cookbook + version + universe + download all resolve.
    const cb = await owner.ctx.get(`/${repo.mountPath}/api/v1/cookbooks/${cookbook}`);
    expect(cb.status()).toBe(200);
    expect((await cb.json()).latest_version).toContain("1_0_0");
    const dl = await owner.ctx.get(
      `/${repo.mountPath}/api/v1/cookbooks/${cookbook}/versions/1_0_0/download`,
    );
    expect(dl.status()).toBe(200);
    expect((await owner.ctx.get(`/${repo.mountPath}/universe`)).status()).toBe(200);

    // Consume with the real knife client. supermarket_site is the repo ROOT URL
    // (knife appends /api/v1/... itself). Plain http needs no insecure flag.
    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-chef-"));
    writeFileSync(join(work, "config.rb"), `knife[:supermarket_site] = "${repoUrl}"\n`);

    const list = knife(["supermarket", "search", cookbook, "-c", join(work, "config.rb")], work);
    expect(list).toContain(cookbook);

    knife(
      [
        "supermarket",
        "download",
        cookbook,
        version,
        "-c",
        join(work, "config.rb"),
        "-f",
        join(work, "dl.tar.gz"),
      ],
      work,
    );
    expect(existsSync(join(work, "dl.tar.gz"))).toBe(true);
    expect(statSync(join(work, "dl.tar.gz")).size).toBeGreaterThan(0);
  });
});
