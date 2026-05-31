import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, setupOwner } from "./helpers";

function sh(cmd: string, args: string[], input?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", input });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.describe("docker registry (real CLI)", () => {
  test.skip(!dockerAvailable(), "docker daemon not available");

  test("docker build -> push -> pull round-trips", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(baseURL!).host; // 127.0.0.1:3399 (insecure-allowed by docker)
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "containers", format: "docker" })).status(),
    ).toBe(201);

    const image = `${host}/${owner.orgSlug}/containers/app`;
    const ref = `${image}:1.0`;

    // login (creds stored, used for the per-op token flow)
    sh("docker", ["login", host, "-u", owner.username, "--password-stdin"], owner.password);

    // build a tiny FROM scratch image (no network needed)
    const ctxDir = mkdtempSync(join(tmpdir(), "hoot-docker-"));
    writeFileSync(join(ctxDir, "hello.txt"), "hello from hootifactory\n");
    writeFileSync(join(ctxDir, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n");
    sh("docker", ["build", "-t", ref, ctxDir]);

    // push
    sh("docker", ["push", ref]);

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
    sh("docker", ["rmi", "-f", ref]);
    sh("docker", ["pull", ref]);
    const inspect = sh("docker", ["image", "inspect", ref]);
    expect(inspect).toContain(`${owner.orgSlug}/containers/app`);

    // cleanup
    try {
      sh("docker", ["rmi", "-f", ref]);
      sh("docker", ["logout", host]);
    } catch {
      /* ignore */
    }
  });
});
