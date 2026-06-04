import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepo, setupOwner, uniq } from "./helpers";

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
      (
        await createRepo(owner.ctx, owner.orgId, { name: "containers", moduleId: "docker" })
      ).status(),
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

/** Write a FROM-scratch build context (offline) and return its directory. */
function scratchContext(): string {
  const ctxDir = mkdtempSync(join(tmpdir(), "hoot-docker-"));
  writeFileSync(join(ctxDir, "hello.txt"), "hello from hootifactory\n");
  writeFileSync(join(ctxDir, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n");
  return ctxDir;
}

/** Parse the `sha256:...` digest out of a `repo@sha256:...` reference. */
function digestOf(repoDigest: string): string {
  const at = repoDigest.lastIndexOf("@");
  return at >= 0 ? repoDigest.slice(at + 1) : repoDigest;
}

test.describe("docker registry extended scenarios (Dockerized real CLI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("multiple tags on one image push and pull back", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-tags");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const image = `${host}/${owner.orgSlug}/${repoName}/app`;
    const versioned = `${image}:1.0`;
    const latest = `${image}:latest`;

    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", versioned, scratchContext()], dockerConfig);
    docker(["tag", versioned, latest], dockerConfig);
    docker(["push", versioned], dockerConfig);
    docker(["push", latest], dockerConfig);

    const tagsRes = await owner.ctx.get(`/v2/${owner.orgSlug}/${repoName}/app/tags/list`);
    expect(tagsRes.status()).toBe(200);
    const tags = (await tagsRes.json()).tags as string[];
    expect(tags).toContain("1.0");
    expect(tags).toContain("latest");

    docker(["rmi", "-f", versioned, latest], dockerConfig);
    docker(["pull", versioned], dockerConfig);
    docker(["pull", latest], dockerConfig);
    expect(docker(["image", "inspect", versioned], dockerConfig)).toContain(
      `${owner.orgSlug}/${repoName}/app`,
    );
    expect(docker(["image", "inspect", latest], dockerConfig)).toContain(
      `${owner.orgSlug}/${repoName}/app`,
    );

    try {
      docker(["rmi", "-f", versioned, latest], dockerConfig);
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });

  test("pull by content digest", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-digest");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const image = `${host}/${owner.orgSlug}/${repoName}/app`;
    const ref = `${image}:1.0`;

    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", ref, scratchContext()], dockerConfig);
    docker(["push", ref], dockerConfig);

    const repoDigest = docker(
      ["inspect", "--format", "{{index .RepoDigests 0}}", ref],
      dockerConfig,
    ).trim();
    const digest = digestOf(repoDigest);
    expect(digest).toMatch(/^sha256:/);

    // confirm the digest matches what the registry reports for the tag
    const head = await owner.ctx.head(`/v2/${owner.orgSlug}/${repoName}/app/manifests/1.0`);
    expect(head.status()).toBe(200);
    expect(head.headers()["docker-content-digest"]).toBe(digest);

    docker(["rmi", "-f", ref], dockerConfig);
    const byDigest = `${image}@${digest}`;
    docker(["pull", byDigest], dockerConfig);
    expect(docker(["image", "inspect", byDigest], dockerConfig)).toContain(
      `${owner.orgSlug}/${repoName}/app`,
    );

    try {
      docker(["rmi", "-f", byDigest], dockerConfig);
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });

  test("deleting a tag via the registry API removes it from the repository", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-untag");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const ref = `${host}/${owner.orgSlug}/${repoName}/app:1.0`;
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", ref, scratchContext()], dockerConfig);
    docker(["push", ref], dockerConfig);

    const manifestPath = `/v2/${owner.orgSlug}/${repoName}/app/manifests`;
    const head = await owner.ctx.head(`${manifestPath}/1.0`);
    expect(head.status()).toBe(200);
    const digest = head.headers()["docker-content-digest"];
    expect(digest).toMatch(/^sha256:/);

    const deleted = await owner.ctx.delete(`${manifestPath}/1.0`);
    expect(deleted.status()).toBe(202);

    // The deleted tag no longer resolves and drops out of the tag listing.
    const byTag = await owner.ctx.get(`${manifestPath}/1.0`);
    expect(byTag.status()).toBe(404);

    const tagsList = await owner.ctx.get(`/v2/${owner.orgSlug}/${repoName}/app/tags/list`);
    expect(tagsList.status()).toBe(200);
    expect(((await tagsList.json()).tags ?? []) as string[]).not.toContain("1.0");

    try {
      docker(["rmi", "-f", ref], dockerConfig);
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });

  test("anonymous pull is allowed for a public repo", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-public");
    expect(
      (
        await createRepo(owner.ctx, owner.orgId, {
          name: repoName,
          moduleId: "docker",
          visibility: "public",
        })
      ).status(),
    ).toBe(201);

    const ref = `${host}/${owner.orgSlug}/${repoName}/app:pub`;
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", ref, scratchContext()], dockerConfig);
    docker(["push", ref], dockerConfig);
    docker(["rmi", "-f", ref], dockerConfig);
    docker(["logout", host], dockerConfig);

    // a fresh, empty docker config holds no credentials at all
    const anonConfig = mkdtempSync(join(tmpdir(), "hoot-docker-anon-"));
    docker(["pull", ref], anonConfig);
    expect(docker(["image", "inspect", ref], anonConfig)).toContain(
      `${owner.orgSlug}/${repoName}/app`,
    );

    try {
      docker(["rmi", "-f", ref], anonConfig);
    } catch {
      /* ignore */
    }
  });

  test("push is rejected without authentication", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-private");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const ref = `${host}/${owner.orgSlug}/${repoName}/app:priv`;
    // build with a fresh, empty config (no docker login ever performed)
    docker(["build", "-t", ref, scratchContext()], dockerConfig);

    let pushError = "";
    try {
      docker(["push", ref], dockerConfig);
    } catch (err) {
      pushError = (err as Error).message;
    }
    expect(pushError).not.toBe("");
    expect(pushError.toLowerCase()).toMatch(/unauthorized|denied|401/);

    try {
      docker(["rmi", "-f", ref], dockerConfig);
    } catch {
      /* ignore */
    }
  });
});

test.describe("docker registry error and edge scenarios (Dockerized real CLI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("pulling a nonexistent tag fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-missing-tag");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const image = `${host}/${owner.orgSlug}/${repoName}/app`;
    const ref = `${image}:1.0`;
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", ref, scratchContext()], dockerConfig);
    docker(["push", ref], dockerConfig);

    // version 2.0 was never pushed: the registry has no manifest for that tag
    let pullError = "";
    try {
      docker(["pull", `${image}:2.0`], dockerConfig);
    } catch (err) {
      pullError = (err as Error).message;
    }
    expect(pullError).not.toBe("");
    expect(pullError.toLowerCase()).toMatch(/not found|manifest unknown|unknown|404/);

    try {
      docker(["rmi", "-f", ref], dockerConfig);
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });

  test("pulling a nonexistent repository fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    // an authenticated session that never created this repository
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);

    const missingRepo = uniq("docker-no-such-repo");
    const ref = `${host}/${owner.orgSlug}/${missingRepo}/app:1.0`;
    let pullError = "";
    try {
      docker(["pull", ref], dockerConfig);
    } catch (err) {
      pullError = (err as Error).message;
    }
    expect(pullError).not.toBe("");
    expect(pullError.toLowerCase()).toMatch(/not found|unauthorized|denied|unknown|404|401|403/);

    try {
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });

  test("pulling a private repo without authentication is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    // private is the default (visibility omitted)
    const repoName = uniq("docker-private-pull");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const ref = `${host}/${owner.orgSlug}/${repoName}/app:1.0`;
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", ref, scratchContext()], dockerConfig);
    docker(["push", ref], dockerConfig);
    docker(["rmi", "-f", ref], dockerConfig);
    docker(["logout", host], dockerConfig);

    // a fresh, empty docker config holds no credentials at all
    const anonConfig = mkdtempSync(join(tmpdir(), "hoot-docker-anon-"));
    let pullError = "";
    try {
      docker(["pull", ref], anonConfig);
    } catch (err) {
      pullError = (err as Error).message;
    }
    expect(pullError).not.toBe("");
    expect(pullError.toLowerCase()).toMatch(/unauthorized|denied|authentication|401/);

    try {
      docker(["rmi", "-f", ref], anonConfig);
    } catch {
      /* ignore */
    }
  });

  test("pulling by a nonexistent digest fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const dockerConfig = mkdtempSync(join(tmpdir(), "hoot-docker-config-"));
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("docker-bad-digest");
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })).status(),
    ).toBe(201);

    const image = `${host}/${owner.orgSlug}/${repoName}/app`;
    const ref = `${image}:1.0`;
    docker(["login", host, "-u", owner.username, "--password-stdin"], dockerConfig, owner.password);
    docker(["build", "-t", ref, scratchContext()], dockerConfig);
    docker(["push", ref], dockerConfig);

    // a syntactically valid but unknown digest (64 hex zeros) has no manifest
    const zeroDigest = `sha256:${"0".repeat(64)}`;
    let pullError = "";
    try {
      docker(["pull", `${image}@${zeroDigest}`], dockerConfig);
    } catch (err) {
      pullError = (err as Error).message;
    }
    expect(pullError).not.toBe("");
    expect(pullError.toLowerCase()).toMatch(/not found|manifest unknown|unknown|404/);

    try {
      docker(["rmi", "-f", ref], dockerConfig);
      docker(["logout", host], dockerConfig);
    } catch {
      /* ignore */
    }
  });
});
