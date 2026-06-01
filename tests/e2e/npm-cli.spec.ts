import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dockerNpm, dockerReachableUrl, ensureDockerAvailable } from "./docker-clients";
import { createRepo, createToken, setupOwner } from "./helpers";

function npm(args: string[], cwd: string): string {
  return dockerNpm(args, cwd);
}

test.describe("npm registry (Dockerized real CLI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("npm publish -> npm install round-trips", async ({ baseURL }) => {
    test.setTimeout(120_000);

    const owner = await setupOwner(baseURL!);
    const repoName = "npmrepo";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "npm" })).json())
      .secret as string;

    const registry = `${dockerReachableUrl(baseURL!)}/npm/${owner.orgSlug}/${repoName}/`;
    const authLine = `${registry.replace(/^https?:/, "")}:_authToken=${secret}`;
    const npmrc = `registry=${registry}\n${authLine}\n`;
    const pkgName = `e2e-pkg-${Date.now().toString(36)}`;

    const pubDir = mkdtempSync(join(tmpdir(), "hoot-pub-"));
    writeFileSync(
      join(pubDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.0.0", description: "e2e", main: "index.js" }),
    );
    writeFileSync(join(pubDir, "index.js"), `module.exports = ${JSON.stringify(pkgName)};\n`);
    writeFileSync(join(pubDir, ".npmrc"), npmrc);
    npm(["publish", "--registry", registry], pubDir);

    const insDir = mkdtempSync(join(tmpdir(), "hoot-ins-"));
    writeFileSync(join(insDir, ".npmrc"), npmrc);
    writeFileSync(
      join(insDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", `${pkgName}@1.0.0`, "--registry", registry, "--no-fund"], insDir);

    const installed = join(insDir, "node_modules", pkgName, "index.js");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toContain(pkgName);

    const meta = await owner.ctx.get(`/npm/${owner.orgSlug}/${repoName}/${pkgName}`);
    expect(meta.status()).toBe(200);
    const doc = await meta.json();
    expect(doc.versions["1.0.0"]).toBeTruthy();
    expect(doc["dist-tags"].latest).toBe("1.0.0");
  });

  test("scoped package supports whoami and dist-tags", async ({ baseURL }) => {
    test.setTimeout(120_000);

    const owner = await setupOwner(baseURL!);
    const repoName = "npmrepo-tags";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "npm-tags" })).json())
      .secret as string;

    const registry = `${dockerReachableUrl(baseURL!)}/npm/${owner.orgSlug}/${repoName}/`;
    const npmrc = [
      `registry=${registry}`,
      `${registry.replace(/^https?:/, "")}:_authToken=${secret}`,
      "",
    ].join("\n");
    const id = Date.now().toString(36);
    const pkgName = `@hoot-${id}/scoped-pkg`;

    const pubDir = mkdtempSync(join(tmpdir(), "hoot-npm-scoped-"));
    writeFileSync(
      join(pubDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.0.0", description: "e2e", main: "index.js" }),
    );
    writeFileSync(join(pubDir, "index.js"), `module.exports = ${JSON.stringify(pkgName)};\n`);
    writeFileSync(join(pubDir, ".npmrc"), npmrc);

    expect(npm(["whoami", "--registry", registry], pubDir).trim()).toBe("token");
    npm(["publish", "--registry", registry, "--access", "public"], pubDir);
    npm(["dist-tag", "add", `${pkgName}@1.0.0`, "beta", "--registry", registry], pubDir);
    const tags = npm(["dist-tag", "ls", pkgName, "--registry", registry], pubDir);
    expect(tags).toContain("latest: 1.0.0");
    expect(tags).toContain("beta: 1.0.0");

    const insDir = mkdtempSync(join(tmpdir(), "hoot-npm-scoped-ins-"));
    writeFileSync(join(insDir, ".npmrc"), npmrc);
    writeFileSync(
      join(insDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", `${pkgName}@beta`, "--registry", registry, "--no-audit", "--no-fund"], insDir);
    expect(existsSync(join(insDir, "node_modules", pkgName, "index.js"))).toBe(true);

    npm(["dist-tag", "rm", pkgName, "beta", "--registry", registry], pubDir);
    const afterRm = npm(["dist-tag", "ls", pkgName, "--registry", registry], pubDir);
    expect(afterRm).toContain("latest: 1.0.0");
    expect(afterRm).not.toContain("beta:");
    let removedTagFailed = false;
    try {
      npm(["view", `${pkgName}@beta`, "version", "--registry", registry], pubDir);
    } catch {
      removedTagFailed = true;
    }
    expect(removedTagFailed).toBe(true);
  });

  test("scope registry config drives publish, view, pack, and install", async ({ baseURL }) => {
    test.setTimeout(120_000);

    const owner = await setupOwner(baseURL!);
    const repoName = "npmrepo-scope-config";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "npm-scope-config" })).json()
    ).secret as string;

    const registry = `${dockerReachableUrl(baseURL!)}/npm/${owner.orgSlug}/${repoName}/`;
    const id = Date.now().toString(36);
    const scope = `@hoot-${id}`;
    const pkgName = `${scope}/scope-config-pkg`;
    const npmrc = [
      `${scope}:registry=${registry}`,
      `${registry.replace(/^https?:/, "")}:_authToken=${secret}`,
      "",
    ].join("\n");

    const pubDir = mkdtempSync(join(tmpdir(), "hoot-npm-scope-config-"));
    writeFileSync(
      join(pubDir, "package.json"),
      JSON.stringify({
        name: pkgName,
        version: "1.0.0",
        description: "scope registry config",
        license: "MIT",
        keywords: ["scope", "registry"],
        main: "index.js",
        bin: { "scope-config-pkg": "cli.js" },
      }),
    );
    writeFileSync(join(pubDir, "index.js"), "module.exports = 'scoped registry';\n");
    writeFileSync(join(pubDir, "cli.js"), "#!/usr/bin/env node\nconsole.log('scoped registry');\n");
    writeFileSync(join(pubDir, "README.md"), "# scoped registry config\n");
    writeFileSync(join(pubDir, ".npmrc"), npmrc);

    npm(["publish", "--access", "public"], pubDir);

    const view = JSON.parse(npm(["view", pkgName, "--json"], pubDir)) as {
      bin: Record<string, string>;
      description: string;
      keywords: string[];
      license: string;
      name: string;
      version: string;
    };
    expect(view).toMatchObject({
      name: pkgName,
      version: "1.0.0",
      description: "scope registry config",
      license: "MIT",
    });
    expect(view.keywords).toEqual(["scope", "registry"]);
    expect(view.bin["scope-config-pkg"]).toBe("cli.js");

    const info = JSON.parse(npm(["info", pkgName, "--json"], pubDir)) as {
      name: string;
      version: string;
    };
    expect(info).toMatchObject({ name: pkgName, version: "1.0.0" });

    const versions = JSON.parse(npm(["view", pkgName, "versions", "--json"], pubDir)) as string[];
    expect(versions).toContain("1.0.0");
    const tags = JSON.parse(npm(["view", pkgName, "dist-tags", "--json"], pubDir)) as {
      latest: string;
    };
    expect(tags.latest).toBe("1.0.0");

    const packDir = mkdtempSync(join(tmpdir(), "hoot-npm-pack-"));
    writeFileSync(join(packDir, ".npmrc"), npmrc);
    const packResult = JSON.parse(npm(["pack", `${pkgName}@1.0.0`, "--json"], packDir)) as {
      filename: string;
      integrity: string;
      name: string;
      version: string;
    }[];
    expect(packResult).toHaveLength(1);
    expect(packResult[0]).toMatchObject({ name: pkgName, version: "1.0.0" });
    expect(packResult[0]!.filename).toMatch(/\.tgz$/);
    expect(packResult[0]!.integrity).toMatch(/^sha512-/);
    expect(existsSync(join(packDir, packResult[0]!.filename))).toBe(true);

    writeFileSync(
      join(packDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", `./${packResult[0]!.filename}`, "--no-audit", "--no-fund"], packDir);
    expect(existsSync(join(packDir, "node_modules", scope, "scope-config-pkg", "index.js"))).toBe(
      true,
    );
  });

  test("publish --tag preserves latest while beta resolves a newer version", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);

    const owner = await setupOwner(baseURL!);
    const repoName = "npmrepo-publish-tag";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "npm-tag" })).json())
      .secret as string;

    const registry = `${dockerReachableUrl(baseURL!)}/npm/${owner.orgSlug}/${repoName}/`;
    const npmrc = [
      `registry=${registry}`,
      `${registry.replace(/^https?:/, "")}:_authToken=${secret}`,
      "",
    ].join("\n");
    const pkgName = `tagged-pkg-${Date.now().toString(36)}`;

    const pubDir = mkdtempSync(join(tmpdir(), "hoot-npm-tagged-"));
    writeFileSync(
      join(pubDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.0.0", description: "tagged", main: "index.js" }),
    );
    writeFileSync(join(pubDir, "index.js"), "module.exports = 'stable';\n");
    writeFileSync(join(pubDir, ".npmrc"), npmrc);

    npm(["publish", "--registry", registry], pubDir);

    writeFileSync(
      join(pubDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.1.0", description: "tagged", main: "index.js" }),
    );
    writeFileSync(join(pubDir, "index.js"), "module.exports = 'beta';\n");
    npm(["publish", "--tag", "beta", "--registry", registry], pubDir);

    let duplicateFailed = false;
    try {
      npm(["publish", "--tag", "beta", "--registry", registry], pubDir);
    } catch {
      duplicateFailed = true;
    }
    expect(duplicateFailed).toBe(true);

    const packument = await (
      await owner.ctx.get(`/npm/${owner.orgSlug}/${repoName}/${pkgName}`)
    ).json();
    expect(packument["dist-tags"].latest).toBe("1.0.0");
    expect(packument["dist-tags"].beta).toBe("1.1.0");

    const view = JSON.parse(
      npm(["view", `${pkgName}@beta`, "--json", "--registry", registry], pubDir),
    ) as { name: string; version: string; dist: { integrity: string } };
    expect(view).toMatchObject({ name: pkgName, version: "1.1.0" });
    expect(view.dist.integrity).toMatch(/^sha512-/);

    const stableDir = mkdtempSync(join(tmpdir(), "hoot-npm-stable-ins-"));
    writeFileSync(join(stableDir, ".npmrc"), npmrc);
    writeFileSync(
      join(stableDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", pkgName, "--registry", registry, "--no-audit", "--no-fund"], stableDir);
    expect(readFileSync(join(stableDir, "node_modules", pkgName, "index.js"), "utf8")).toContain(
      "stable",
    );

    const betaDir = mkdtempSync(join(tmpdir(), "hoot-npm-beta-ins-"));
    writeFileSync(join(betaDir, ".npmrc"), npmrc);
    writeFileSync(
      join(betaDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", `${pkgName}@beta`, "--registry", registry, "--no-audit", "--no-fund"], betaDir);
    expect(readFileSync(join(betaDir, "node_modules", pkgName, "index.js"), "utf8")).toContain(
      "beta",
    );

    npm(["dist-tag", "add", `${pkgName}@1.1.0`, "latest", "--registry", registry], pubDir);
    expect(npm(["view", pkgName, "version", "--registry", registry], pubDir).trim()).toBe("1.1.0");

    const promotedDir = mkdtempSync(join(tmpdir(), "hoot-npm-promoted-ins-"));
    writeFileSync(join(promotedDir, ".npmrc"), npmrc);
    writeFileSync(
      join(promotedDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(["install", pkgName, "--registry", registry, "--no-audit", "--no-fund"], promotedDir);
    expect(readFileSync(join(promotedDir, "node_modules", pkgName, "index.js"), "utf8")).toContain(
      "beta",
    );

    npm(["dist-tag", "rm", pkgName, "latest", "--registry", registry], pubDir);
    const tagsAfterLatestRm = npm(["dist-tag", "ls", pkgName, "--registry", registry], pubDir);
    expect(tagsAfterLatestRm).not.toContain("latest:");

    const exactDir = mkdtempSync(join(tmpdir(), "hoot-npm-exact-ins-"));
    writeFileSync(join(exactDir, ".npmrc"), npmrc);
    writeFileSync(
      join(exactDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
    );
    npm(
      ["install", `${pkgName}@1.0.0`, "--registry", registry, "--no-audit", "--no-fund"],
      exactDir,
    );
    expect(readFileSync(join(exactDir, "node_modules", pkgName, "index.js"), "utf8")).toContain(
      "stable",
    );
  });
});
