import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepo, setupOwner } from "./helpers";

function docker(args: string[], dockerConfig: string, input?: string): string {
  return dockerRun(CLI_IMAGES.docker, args, {
    dockerSocket: true,
    entrypoint: "docker",
    env: { DOCKER_CONFIG: dockerConfig },
    input,
    user: "root",
  });
}

test.describe("docker registry (Dockerized real CLI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("docker build -> push -> pull round-trips", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "containers", format: "docker" })).status(),
    ).toBe(201);

    const image = `${host}/${owner.orgSlug}/containers/app`;
    const ref = `${image}:1.0`;

    // login (creds stored, used for the per-op token flow)
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);

    // build a tiny FROM scratch image (no network needed)
    const ctxDir = mkdtempSync(join(tmpdir(), "hoot-docker-"));
    writeFileSync(join(ctxDir, "hello.txt"), "hello from hootifactory\n");
    writeFileSync(join(ctxDir, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n");
    docker(["build", "-t", ref, ctxDir], dockerConfig);

    // push
    docker(["push", ref], dockerConfig);

    // the tag is visible via the registry API
    const tagsRes = await owner.ctx.get(`/v2/${owner.orgSlug}/containers/app/tags/list`);
    expect(tagsRes.status()).toBe(200);
    const tags = await tagsRes.json();
    expect(tags.tags).toContain("1.0");

    // manifest HEAD returns a content digest
    const head = await owner.ctx.head(`/v2/${owner.orgSlug}/containers/app/manifests/1.0`);
    expect(head.status()).toBe(200);
    expect(head.headers()["docker-content-digest"]).toMatch(/^sha256:/);

    // remove locally, then pull back from our registry
    docker(["rmi", "-f", ref], dockerConfig);
    docker(["pull", ref], dockerConfig);
    const inspect = docker(["image", "inspect", ref], dockerConfig);
    expect(inspect).toContain(`${owner.orgSlug}/containers/app`);

    // cleanup
    try {
      docker(["rmi", "-f", ref], dockerConfig);
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });
});
