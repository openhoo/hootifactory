import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, setupOwner } from "./helpers";

function sh(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.describe("helm registry (real CLI, OCI)", () => {
  test.skip(!helmAvailable(), "helm not available");

  test("helm package -> push -> pull (OCI)", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(baseURL!).host;
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "charts", format: "helm" })).status(),
    ).toBe(201);

    const work = mkdtempSync(join(tmpdir(), "hoot-helm-"));
    sh("helm", ["create", "mychart"], work);
    sh("helm", ["package", join(work, "mychart"), "-d", work]);

    sh("helm", [
      "registry",
      "login",
      host,
      "-u",
      owner.username,
      "-p",
      owner.password,
      "--plain-http",
    ]);
    sh("helm", [
      "push",
      join(work, "mychart-0.1.0.tgz"),
      `oci://${host}/${owner.orgSlug}/charts`,
      "--plain-http",
    ]);

    const pullDir = mkdtempSync(join(tmpdir(), "hoot-helm-pull-"));
    sh("helm", [
      "pull",
      `oci://${host}/${owner.orgSlug}/charts/mychart`,
      "--version",
      "0.1.0",
      "--plain-http",
      "-d",
      pullDir,
    ]);
    expect(existsSync(join(pullDir, "mychart-0.1.0.tgz"))).toBe(true);

    // tag is visible via the registry API
    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/charts/mychart/tags/list`);
    expect(tags.status()).toBe(200);
    expect((await tags.json()).tags).toContain("0.1.0");

    try {
      sh("helm", ["registry", "logout", host, "--plain-http"]);
    } catch {
      /* ignore */
    }
  });
});
