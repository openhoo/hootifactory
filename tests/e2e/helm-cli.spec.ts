import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepo, createRepoReturning, setupOwner } from "./helpers";

function helm(args: string[], cwd: string, helmHome: string): string {
  return dockerRun(CLI_IMAGES.helm, args, {
    cwd,
    env: {
      HELM_CACHE_HOME: join(helmHome, ".cache", "helm"),
      HELM_CONFIG_HOME: join(helmHome, ".config", "helm"),
      HELM_DATA_HOME: join(helmHome, ".local", "share", "helm"),
      HOME: helmHome,
    },
  });
}

test.describe("helm registry (Dockerized real CLI, OCI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("helm package -> push -> pull (OCI)", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "charts", moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    helm(["create", "mychart"], work, helmHome);
    helm(["package", join(work, "mychart"), "-d", work], work, helmHome);

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );
    helm(
      [
        "push",
        join(work, "mychart-0.1.0.tgz"),
        `oci://${host}/${owner.orgSlug}/charts`,
        "--plain-http",
      ],
      work,
      helmHome,
    );

    const pullDir = mkdtempSync(join(tmpdir(), "hoot-helm-pull-"));
    helm(
      [
        "pull",
        `oci://${host}/${owner.orgSlug}/charts/mychart`,
        "--version",
        "0.1.0",
        "--plain-http",
        "-d",
        pullDir,
      ],
      work,
      helmHome,
    );
    expect(existsSync(join(pullDir, "mychart-0.1.0.tgz"))).toBe(true);

    // tag is visible via the registry API
    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/charts/mychart/tags/list`);
    expect(tags.status()).toBe(200);
    expect((await tags.json()).tags).toContain("0.1.0");

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });
});

/** Unique, lowercase, DNS-safe chart name (helm chart names must be lowercase). */
function uniqChart(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** Scaffold a chart, override its version, and package it into <work>; returns the .tgz path. */
function scaffoldAndPackage(
  work: string,
  helmHome: string,
  chart: string,
  version: string,
): string {
  helm(["create", chart], work, helmHome);
  if (version !== "0.1.0") {
    const chartYaml = join(work, chart, "Chart.yaml");
    const original = readFileSync(chartYaml, "utf8");
    writeFileSync(chartYaml, original.replace(/^version:.*$/m, `version: ${version}`));
  }
  helm(["package", join(work, chart), "-d", work], work, helmHome);
  return join(work, `${chart}-${version}.tgz`);
}

test.describe("helm registry extended scenarios (Dockerized real CLI, OCI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("helm show chart returns Chart.yaml metadata", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-showchart";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-showchart-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("showchart");
    const tgz = scaffoldAndPackage(work, helmHome, chart, "0.1.0");

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );
    helm(["push", tgz, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);

    const shown = helm(
      [
        "show",
        "chart",
        `oci://${host}/${owner.orgSlug}/${repo}/${chart}`,
        "--version",
        "0.1.0",
        "--plain-http",
      ],
      work,
      helmHome,
    );
    expect(shown).toContain(`name: ${chart}`);
    expect(shown).toContain("version: 0.1.0");

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });

  test("helm show values returns the chart values", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-showvalues";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-showvalues-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("showvalues");
    const tgz = scaffoldAndPackage(work, helmHome, chart, "0.1.0");

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );
    helm(["push", tgz, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);

    const values = helm(
      [
        "show",
        "values",
        `oci://${host}/${owner.orgSlug}/${repo}/${chart}`,
        "--version",
        "0.1.0",
        "--plain-http",
      ],
      work,
      helmHome,
    );
    // "replicaCount" is a default key produced by `helm create` scaffolding.
    expect(values).toContain("replicaCount");

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });

  test("multiple chart versions can be pushed and pulled independently", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-multiver";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-multiver-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("multiver");
    // scaffold once at 0.1.0, then bump Chart.yaml to 0.2.0 and repackage.
    const tgzV1 = scaffoldAndPackage(work, helmHome, chart, "0.1.0");
    const chartYaml = join(work, chart, "Chart.yaml");
    writeFileSync(
      chartYaml,
      readFileSync(chartYaml, "utf8").replace(/^version:.*$/m, "version: 0.2.0"),
    );
    helm(["package", join(work, chart), "-d", work], work, helmHome);
    const tgzV2 = join(work, `${chart}-0.2.0.tgz`);
    expect(existsSync(tgzV1)).toBe(true);
    expect(existsSync(tgzV2)).toBe(true);

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );
    helm(["push", tgzV1, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);
    helm(["push", tgzV2, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);

    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/${repo}/${chart}/tags/list`);
    expect(tags.status()).toBe(200);
    const tagList = (await tags.json()).tags as string[];
    expect(tagList).toContain("0.1.0");
    expect(tagList).toContain("0.2.0");

    const pullV1 = mkdtempSync(join(tmpdir(), "hoot-helm-multiver-v1-"));
    helm(
      [
        "pull",
        `oci://${host}/${owner.orgSlug}/${repo}/${chart}`,
        "--version",
        "0.1.0",
        "--plain-http",
        "-d",
        pullV1,
      ],
      work,
      helmHome,
    );
    expect(existsSync(join(pullV1, `${chart}-0.1.0.tgz`))).toBe(true);

    const pullV2 = mkdtempSync(join(tmpdir(), "hoot-helm-multiver-v2-"));
    helm(
      [
        "pull",
        `oci://${host}/${owner.orgSlug}/${repo}/${chart}`,
        "--version",
        "0.2.0",
        "--plain-http",
        "-d",
        pullV2,
      ],
      work,
      helmHome,
    );
    expect(existsSync(join(pullV2, `${chart}-0.2.0.tgz`))).toBe(true);

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });

  test("helm pull --untar expands the chart directory", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-untar";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-untar-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("untar");
    const tgz = scaffoldAndPackage(work, helmHome, chart, "0.1.0");

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );
    helm(["push", tgz, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);

    const untarDir = mkdtempSync(join(tmpdir(), "hoot-helm-untar-out-"));
    helm(
      [
        "pull",
        `oci://${host}/${owner.orgSlug}/${repo}/${chart}`,
        "--version",
        "0.1.0",
        "--plain-http",
        "--untar",
        "-d",
        untarDir,
      ],
      work,
      helmHome,
    );
    // --untar expands into a chart subdirectory rather than leaving a .tgz.
    expect(existsSync(join(untarDir, chart, "Chart.yaml"))).toBe(true);

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });

  // NOTE: like OCI, Helm (which rides the OCI plugin) virtual repositories are
  // not exercised for chart *reads* via the real CLI — the OCI bearer token is
  // scoped to the virtual repo's path and per-member re-authorization rejects a
  // pull through the virtual repo. We assert the defined read-only contract:
  // pushing a chart to a virtual repo is rejected.
  test("writes are rejected on a virtual helm repository", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);

    const virtualName = "charts-virtual";
    await createRepoReturning(owner.ctx, owner.orgId, {
      name: virtualName,
      moduleId: "helm",
      kind: "virtual",
    });

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-virtual-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("virt");
    const tgz = scaffoldAndPackage(work, helmHome, chart, "0.1.0");

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );

    let virtualPushFailed = false;
    try {
      helm(
        ["push", tgz, `oci://${host}/${owner.orgSlug}/${virtualName}`, "--plain-http"],
        work,
        helmHome,
      );
    } catch {
      virtualPushFailed = true;
    }
    expect(virtualPushFailed).toBe(true);

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });
});

test.describe("helm registry error and edge scenarios (Dockerized real CLI, OCI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("pulling a nonexistent chart fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-pull-missing-chart";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-pull-missing-chart-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );

    const missingChart = uniqChart("ghost");
    const pullDir = mkdtempSync(join(tmpdir(), "hoot-helm-pull-missing-chart-out-"));
    let failed = false;
    let message = "";
    try {
      helm(
        [
          "pull",
          `oci://${host}/${owner.orgSlug}/${repo}/${missingChart}`,
          "--version",
          "0.1.0",
          "--plain-http",
          "-d",
          pullDir,
        ],
        work,
        helmHome,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unauthorized|denied|401|403|404|manifest unknown/i);
    expect(existsSync(join(pullDir, `${missingChart}-0.1.0.tgz`))).toBe(false);

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });

  test("pulling a nonexistent version of an existing chart fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-pull-missing-version";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-pull-missing-version-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("versioned");
    const tgz = scaffoldAndPackage(work, helmHome, chart, "0.1.0");

    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );
    helm(["push", tgz, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);

    const pullDir = mkdtempSync(join(tmpdir(), "hoot-helm-pull-missing-version-out-"));
    let failed = false;
    let message = "";
    try {
      helm(
        [
          "pull",
          `oci://${host}/${owner.orgSlug}/${repo}/${chart}`,
          "--version",
          "9.9.9",
          "--plain-http",
          "-d",
          pullDir,
        ],
        work,
        helmHome,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unauthorized|denied|401|403|404|manifest unknown/i);
    expect(existsSync(join(pullDir, `${chart}-9.9.9.tgz`))).toBe(false);

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });

  test("pushing without a registry login is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    // Private repo is the default (visibility omitted).
    const repo = "charts-push-noauth";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-push-noauth-"));
    // Fresh helmHome with NO stored registry credentials — never run `registry login`.
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    const chart = uniqChart("noauth");
    const tgz = scaffoldAndPackage(work, helmHome, chart, "0.1.0");

    let failed = false;
    let message = "";
    try {
      helm(["push", tgz, `oci://${host}/${owner.orgSlug}/${repo}`, "--plain-http"], work, helmHome);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/unauthorized|denied|authentication|login|401|403/i);

    // The unauthenticated push must not have created a tag.
    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/${repo}/${chart}/tags/list`);
    expect(tags.status()).not.toBe(200);
  });

  test("helm show chart on a nonexistent chart fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const owner = await setupOwner(baseURL!);
    const repo = "charts-show-missing";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-show-missing-"));
    const helmHome = mkdtempSync(join(tmpdir(), "hoot-helm-home-"));
    helm(
      ["registry", "login", host, "-u", owner.username, "-p", owner.password, "--plain-http"],
      work,
      helmHome,
    );

    const missingChart = uniqChart("phantom");
    let failed = false;
    let message = "";
    try {
      helm(
        [
          "show",
          "chart",
          `oci://${host}/${owner.orgSlug}/${repo}/${missingChart}`,
          "--version",
          "0.1.0",
          "--plain-http",
        ],
        work,
        helmHome,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unauthorized|denied|401|403|404|manifest unknown/i);

    try {
      helm(["registry", "logout", host, "--plain-http"], work, helmHome);
    } catch {
      /* ignore */
    }
  });
});
