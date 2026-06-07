import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
// biome-ignore lint/style/useImportType: buildApkFixture is a runtime value.
import { buildApkFixture } from "../../packages/registry-alpine/src/apk-fixture";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// apk-tools has no publish command (Alpine repos are produced out-of-band), so we
// PUT the .apk over HTTP and then consume with the real `apk` client.
function apkShell(script: string, url: string): string {
  return dockerRun(CLI_IMAGES.alpine, ["-c", script], {
    entrypoint: "sh",
    user: "root",
    env: { HOOTI_REPO: url },
  });
}

test.describe("alpine registry (Dockerized real apk)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT .apk -> apk add round-trips through APKINDEX", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "alpine-cli",
      moduleId: "alpine",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const name = `hootapk${id}`;
    const version = "1.0.0-r0";
    const arch = "x86_64";
    const apk = buildApkFixture({ name, version, arch, description: "hootifactory apk e2e" });

    // Publish via raw HTTP (owner session authorizes the write).
    const put = await owner.ctx.put(`/${repo.mountPath}/${arch}`, {
      data: Buffer.from(apk),
      headers: { "content-type": "application/vnd.alpine.apk" },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, name, version, arch });

    // The regenerated APKINDEX.tar.gz advertises the package.
    const index = await owner.ctx.get(`/${repo.mountPath}/${arch}/APKINDEX.tar.gz`);
    expect(index.status()).toBe(200);
    const indexText = gunzipSync(Buffer.from(await index.body())).toString("latin1");
    expect(indexText).toContain(`P:${name}`);
    expect(indexText).toContain(`V:${version}`);
    expect(indexText).toContain(`A:${arch}`);

    // Consume with the real apk client. The repositories line is the bare base URL;
    // apk appends /<arch>/APKINDEX.tar.gz. The index is unsigned -> --allow-untrusted.
    const url = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const output = apkShell(
      [
        "set -e",
        'echo "$HOOTI_REPO" > /etc/apk/repositories',
        "apk update --allow-untrusted",
        `apk add --allow-untrusted --no-cache ${name}`,
        `apk info -e ${name}`,
      ].join("\n"),
      url,
    );
    expect(output).toContain(name);
  });
});
