import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepo, setupOwner } from "./helpers";

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
      (await createRepo(owner.ctx, owner.orgId, { name: "charts", format: "helm" })).status(),
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
