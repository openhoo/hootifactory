import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  builtClientImage,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
} from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// The generic/raw format is a plain path-addressed blob store; the universal real
// CLI for it is curl (PUT to publish, GET to consume) over plain HTTP with Basic auth.
function curl(args: string[], cwd: string): string {
  return dockerRun(builtClientImage("curl"), ["curl", ...args], { cwd });
}

test.describe("generic registry (Dockerized real curl)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("curl PUT -> curl GET round-trips a raw blob", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "generic-cli",
      moduleId: "generic",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "generic" })).json())
      .data.secret as string;

    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const objectPath = "releases/1.0/app.bin";
    const payload = `hello generic ${Date.now().toString(36)}\n`;

    const work = mkdtempSync(join(tmpdir(), "hoot-generic-"));
    writeFileSync(join(work, "app.bin"), payload);

    // Publish with real curl (Basic __token__:<secret>); body stored verbatim.
    const putOut = curl(
      [
        "-sS",
        "--fail-with-body",
        "-u",
        `__token__:${token}`,
        "-X",
        "PUT",
        "--data-binary",
        "@app.bin",
        "-H",
        "content-type: application/octet-stream",
        `${repoUrl}/${objectPath}`,
      ],
      work,
    );
    expect(putOut).toContain('"ok":true');
    expect(putOut).toContain('"sha256"');

    // Server-side: the blob is retrievable and byte-identical.
    const server = await owner.ctx.get(`/${repo.mountPath}/${objectPath}`);
    expect(server.status()).toBe(200);
    expect(Buffer.from(await server.body())).toEqual(Buffer.from(payload));

    // Consume anonymously with real curl (public repo) and compare bytes.
    curl(["-sS", "--fail-with-body", "-o", "out.bin", `${repoUrl}/${objectPath}`], work);
    expect(readFileSync(join(work, "out.bin"), "utf8")).toBe(payload);

    // The directory listing surfaces the stored path.
    const index = await owner.ctx.get(`/${repo.mountPath}/?prefix=releases`);
    expect(index.status()).toBe(200);
    expect(await index.text()).toContain(objectPath);
  });
});
