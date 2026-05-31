import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

function npm(args: string[], cwd: string): string {
  try {
    return execFileSync("npm", args, {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "npmcache-")) },
    });
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error(`npm ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

test.describe("npm registry (real CLI)", () => {
  test("npm publish -> npm install round-trips", async ({ baseURL }) => {
    test.setTimeout(120_000);

    const owner = await setupOwner(baseURL!);
    const repoName = "npmrepo";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "npm" })).json())
      .secret as string;

    const registry = `${baseURL}/npm/${owner.orgSlug}/${repoName}/`;
    const authLine = `${registry.replace(/^https?:/, "")}:_authToken=${secret}`;
    const npmrc = `registry=${registry}\n${authLine}\n`;
    const pkgName = `e2e-pkg-${Date.now().toString(36)}`;

    // ── publish ──
    const pubDir = mkdtempSync(join(tmpdir(), "hoot-pub-"));
    writeFileSync(
      join(pubDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.0.0", description: "e2e", main: "index.js" }),
    );
    writeFileSync(join(pubDir, "index.js"), `module.exports = ${JSON.stringify(pkgName)};\n`);
    writeFileSync(join(pubDir, ".npmrc"), npmrc);
    npm(["publish", "--registry", registry], pubDir);

    // ── install into a clean project ──
    const insDir = mkdtempSync(join(tmpdir(), "hoot-ins-"));
    writeFileSync(join(insDir, ".npmrc"), npmrc);
    writeFileSync(
      join(insDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", `${pkgName}@1.0.0`, "--registry", registry, "--no-audit", "--no-fund"], insDir);

    const installed = join(insDir, "node_modules", pkgName, "index.js");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toContain(pkgName);

    // packument is served and reports the version
    const meta = await owner.ctx.get(`/npm/${owner.orgSlug}/${repoName}/${pkgName}`);
    expect(meta.status()).toBe(200);
    const doc = await meta.json();
    expect(doc.versions["1.0.0"]).toBeTruthy();
    expect(doc["dist-tags"].latest).toBe("1.0.0");
  });
});
