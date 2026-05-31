import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

function npm(args: string[], cwd: string): void {
  execFileSync("npm", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "npmc-")) },
  });
}

function npmrc(registry: string, token: string): string {
  return `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`;
}

function publish(
  baseURL: string,
  mountPath: string,
  token: string,
  pkgName: string,
  deps: Record<string, string>,
): void {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkgName, version: "1.0.0", main: "index.js", dependencies: deps }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  npm(["publish", "--registry", registry], dir);
}

function install(baseURL: string, mountPath: string, token: string, spec: string): string {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "ins-"));
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  npm(["install", spec, "--registry", registry, "--no-audit", "--no-fund", "--no-save"], dir);
  return dir;
}

async function pollArtifact(
  ctx: APIRequestContext,
  repoId: string,
  name: string,
  timeoutMs = 25_000,
): Promise<{ id: string; state: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.get(`/api/repositories/${repoId}/artifacts`);
    const body = (await res.json()) as { artifacts: { id: string; name: string; state: string }[] };
    const found = body.artifacts.find((a) => a.name === name);
    if (found && found.state !== "pending") return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`artifact ${name} was not scanned within ${timeoutMs}ms`);
}

test.describe("scanning + policy gates", () => {
  test("enforce policy blocks a vulnerable package; clean package is served", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: "scanrepo", format: "npm" })).json()
    ).repository as { id: string; mountPath: string };

    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scanrepo", mode: "enforce", blockOnSeverity: "high" },
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const vulnPkg = `vulnpkg${id}`;
    const cleanPkg = `cleanpkg${id}`;

    publish(baseURL!, repo.mountPath, token, vulnPkg, { "evil-dep": "1.0.0" });
    publish(baseURL!, repo.mountPath, token, cleanPkg, {});

    // vulnerable -> blocked, with a critical finding
    const vulnArt = await pollArtifact(owner.ctx, repo.id, vulnPkg);
    expect(vulnArt.state).toBe("blocked");
    const f = (await (await owner.ctx.get(`/api/artifacts/${vulnArt.id}/findings`)).json()) as {
      findings: { vulnId: string; severity: string }[];
    };
    expect(f.findings.some((x) => x.vulnId === "HOOT-2024-0001" && x.severity === "critical")).toBe(
      true,
    );

    // clean -> clean
    const cleanArt = await pollArtifact(owner.ctx, repo.id, cleanPkg);
    expect(cleanArt.state).toBe("clean");

    // installing the clean package succeeds
    const dir = install(baseURL!, repo.mountPath, token, `${cleanPkg}@1.0.0`);
    expect(existsSync(join(dir, "node_modules", cleanPkg))).toBe(true);

    // installing the blocked package fails (tarball refused with 403)
    let blocked = false;
    try {
      install(baseURL!, repo.mountPath, token, `${vulnPkg}@1.0.0`);
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });
});
