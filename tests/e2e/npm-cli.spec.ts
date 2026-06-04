import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dockerNpm, dockerReachableUrl, ensureDockerAvailable } from "./docker-clients";
import { addUpstream, createRepo, createRepoReturning, createToken, setupOwner } from "./helpers";

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
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
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
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
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

    expect(npm(["whoami", "--registry", registry], pubDir).trim()).toBe(owner.username);
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
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
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
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
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

interface NpmEnv {
  npmrc: string;
  registry: string;
}

function npmEnvForRegistry(registry: string, secret: string): NpmEnv {
  const npmrc = `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${secret}\n`;
  return { npmrc, registry };
}

function npmEnv(baseURL: string, orgSlug: string, repoName: string, secret: string): NpmEnv {
  const registry = `${dockerReachableUrl(baseURL)}/npm/${orgSlug}/${repoName}/`;
  return npmEnvForRegistry(registry, secret);
}

function npmEnvForMountPath(baseURL: string, mountPath: string, secret: string): NpmEnv {
  return npmEnvForRegistry(`${dockerReachableUrl(baseURL)}/${mountPath}/`, secret);
}

function publishVersion(
  env: NpmEnv,
  pkg: string,
  version: string,
  manifest: Record<string, unknown> = {},
  tag?: string,
): void {
  const dir = mkdtempSync(join(tmpdir(), "hoot-npm-pub-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkg, version, main: "index.js", ...manifest }),
  );
  writeFileSync(join(dir, "index.js"), `module.exports = ${JSON.stringify(version)};\n`);
  writeFileSync(join(dir, ".npmrc"), env.npmrc);
  npm(["publish", "--registry", env.registry, ...(tag ? ["--tag", tag] : [])], dir);
}

function consumerDir(env: NpmEnv, dependencies: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "hoot-npm-consumer-"));
  writeFileSync(join(dir, ".npmrc"), env.npmrc);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", private: true, dependencies }),
  );
  return dir;
}

function installedVersion(dir: string, pkg: string): string {
  return JSON.parse(readFileSync(join(dir, "node_modules", pkg, "package.json"), "utf8"))
    .version as string;
}

test.describe("npm registry extended scenarios (Dockerized real CLI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("resolves semver ranges across multiple published versions", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repoName = "npm-semver";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "npm-semver" })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    const pkg = `e2e-semver-${Date.now().toString(36)}`;
    publishVersion(env, pkg, "1.0.0");
    publishVersion(env, pkg, "1.1.0");
    publishVersion(env, pkg, "2.0.0");

    const caretOne = consumerDir(env);
    npm(
      ["install", `${pkg}@^1.0.0`, "--registry", env.registry, "--no-audit", "--no-fund"],
      caretOne,
    );
    expect(installedVersion(caretOne, pkg)).toBe("1.1.0");

    const tilde = consumerDir(env);
    npm(["install", `${pkg}@~1.0.0`, "--registry", env.registry, "--no-audit", "--no-fund"], tilde);
    expect(installedVersion(tilde, pkg)).toBe("1.0.0");

    const caretTwo = consumerDir(env);
    npm(
      ["install", `${pkg}@^2.0.0`, "--registry", env.registry, "--no-audit", "--no-fund"],
      caretTwo,
    );
    expect(installedVersion(caretTwo, pkg)).toBe("2.0.0");
  });

  test("installs transitive dependencies declared in published manifests", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repoName = "npm-deptree";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "npm-deptree" })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    const id = Date.now().toString(36);
    const dep = `e2e-dep-${id}`;
    const main = `e2e-main-${id}`;
    publishVersion(env, dep, "1.2.3");
    publishVersion(env, main, "1.0.0", { dependencies: { [dep]: "^1.0.0" } });

    const dir = consumerDir(env);
    npm(["install", `${main}@1.0.0`, "--registry", env.registry, "--no-audit", "--no-fund"], dir);
    expect(installedVersion(dir, main)).toBe("1.0.0");
    expect(installedVersion(dir, dep)).toBe("1.2.3");
  });

  test("npm ci installs from a lockfile and npm audit consults the advisories endpoint", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repoName = "npm-ci-audit";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "npm-ci-audit" })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    const pkg = `e2e-ci-${Date.now().toString(36)}`;
    publishVersion(env, pkg, "1.0.0");

    const dir = consumerDir(env, { [pkg]: "1.0.0" });
    // install (no --no-audit) writes a lockfile and hits the bulk advisories endpoint
    npm(["install", "--registry", env.registry, "--no-fund"], dir);
    expect(existsSync(join(dir, "package-lock.json"))).toBe(true);

    // npm ci wipes node_modules and reinstalls strictly from the lockfile
    npm(["ci", "--registry", env.registry, "--no-fund"], dir);
    expect(installedVersion(dir, pkg)).toBe("1.0.0");

    // npm audit drives the security advisories endpoint; an unimplemented endpoint
    // would make audit error out, so a clean zero-vuln report proves it responds.
    const audit = JSON.parse(npm(["audit", "--json", "--registry", env.registry], dir)) as {
      metadata: { vulnerabilities: { total: number } };
    };
    expect(audit.metadata.vulnerabilities.total).toBe(0);
  });

  test("npm search surfaces published packages and echoes their metadata", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repoName = "npm-search-cli";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "npm-search-cli" })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    // search matches a substring of the package name; embed a unique token there
    const token = `hootsearch${Date.now().toString(36)}`;
    const pkg = `e2e-${token}-pkg`;
    publishVersion(env, pkg, "1.0.0", {
      description: `a ${token} fixture package`,
      keywords: [token, "hootifactory"],
    });

    const dir = mkdtempSync(join(tmpdir(), "hoot-npm-search-"));
    writeFileSync(join(dir, ".npmrc"), env.npmrc);
    const results = JSON.parse(
      npm(["search", token, "--json", "--registry", env.registry], dir),
    ) as {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
    }[];
    const hit = results.find((r) => r.name === pkg);
    expect(hit).toBeTruthy();
    expect(hit?.version).toBe("1.0.0");
    expect(hit?.description).toContain(token);
    expect(hit?.keywords).toContain(token);
  });

  test("proxy repo mirrors a hosted upstream package through real npm install", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const upstream = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `npm-proxy-up-${suffix}`,
      moduleId: "npm",
      visibility: "public",
    });
    const proxy = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `npm-proxy-cli-${suffix}`,
      moduleId: "npm",
      kind: "proxy",
    });
    expect(
      (await addUpstream(owner.ctx, proxy.id, `${baseURL!}/${upstream.mountPath}/`)).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: `npm-proxy-${suffix}` })).json()
    ).secret as string;

    const pkg = `e2e-proxy-${suffix}`;
    const upstreamEnv = npmEnvForMountPath(baseURL!, upstream.mountPath, secret);
    publishVersion(upstreamEnv, pkg, "1.0.0", { description: "proxy mirror fixture" });

    const directProxyTarball = await owner.ctx.get(`/${proxy.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
    expect(directProxyTarball.status()).toBe(404);

    const proxyEnv = npmEnvForMountPath(baseURL!, proxy.mountPath, secret);
    const dir = consumerDir(proxyEnv);
    npm(
      ["install", `${pkg}@1.0.0`, "--registry", proxyEnv.registry, "--no-audit", "--no-fund"],
      dir,
    );
    expect(installedVersion(dir, pkg)).toBe("1.0.0");

    const packument = await owner.ctx.get(`/${proxy.mountPath}/${pkg}`);
    expect(packument.status()).toBe(200);
    const metadata = await packument.json();
    expect(metadata.versions["1.0.0"].dist.tarball).toContain(`/${proxy.mountPath}/`);

    const mirroredTarball = await owner.ctx.get(`/${proxy.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
    expect(mirroredTarball.status()).toBe(200);
  });

  test("prerelease versions resolve explicitly while latest stays on the stable release", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repoName = "npm-prerelease";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "npm-prerelease" })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    const pkg = `e2e-prerelease-${Date.now().toString(36)}`;
    publishVersion(env, pkg, "1.0.0");
    // publish the prerelease under a non-default tag so "latest" is untouched
    publishVersion(env, pkg, "1.1.0-rc.1", {}, "rc");

    const stable = consumerDir(env);
    npm(["install", pkg, "--registry", env.registry, "--no-audit", "--no-fund"], stable);
    expect(installedVersion(stable, pkg)).toBe("1.0.0");

    const pre = consumerDir(env);
    npm(
      ["install", `${pkg}@^1.1.0-rc.1`, "--registry", env.registry, "--no-audit", "--no-fund"],
      pre,
    );
    expect(installedVersion(pre, pkg)).toBe("1.1.0-rc.1");
  });
});

test.describe("npm registry error and edge scenarios (Dockerized real CLI)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("republishing an existing version is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const repoName = `npm-err-republish-${suffix}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: `npm-republish-${suffix}` })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    const pkg = `e2e-republish-${suffix}`;
    publishVersion(env, pkg, "1.0.0");

    // immutability: republishing the same name@version must be rejected
    let failed = false;
    let message = "";
    try {
      publishVersion(env, pkg, "1.0.0");
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(
      /409|conflict|cannot publish over|previously published|EPUBLISHCONFLICT/i,
    );
  });

  test("installing a nonexistent package fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const repoName = `npm-err-missing-pkg-${suffix}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, { name: `npm-missing-pkg-${suffix}` })
      ).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    // empty repo: nothing was ever published here
    const dir = consumerDir(env);
    const missing = `e2e-absent-${suffix}`;
    let failed = false;
    let message = "";
    try {
      npm(
        ["install", `${missing}@1.0.0`, "--registry", env.registry, "--no-audit", "--no-fund"],
        dir,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/404|not found|E404/i);
  });

  test("installing a nonexistent version of an existing package fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const repoName = `npm-err-missing-ver-${suffix}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, { name: `npm-missing-ver-${suffix}` })
      ).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    const pkg = `e2e-missing-ver-${suffix}`;
    publishVersion(env, pkg, "1.0.0");

    // the package exists, but 9.9.9 was never published -> no satisfying version
    const dir = consumerDir(env);
    let failed = false;
    let message = "";
    try {
      npm(["install", `${pkg}@9.9.9`, "--registry", env.registry, "--no-audit", "--no-fund"], dir);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/No matching version|notarget|ETARGET|404|not found/i);
  });

  test("publishing with an invalid token is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const repoName = `npm-err-bad-token-${suffix}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);

    // build an .npmrc whose _authToken is deliberately wrong
    const registry = `${dockerReachableUrl(baseURL!)}/npm/${owner.orgSlug}/${repoName}/`;
    const npmrc = [
      `registry=${registry}`,
      `${registry.replace(/^https?:/, "")}:_authToken=wrong-token`,
      "",
    ].join("\n");

    const pkg = `e2e-bad-token-${suffix}`;
    const dir = mkdtempSync(join(tmpdir(), "hoot-npm-bad-token-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg, version: "1.0.0", description: "bad token", main: "index.js" }),
    );
    writeFileSync(join(dir, "index.js"), "module.exports = 'bad token';\n");
    writeFileSync(join(dir, ".npmrc"), npmrc);

    let failed = false;
    let message = "";
    try {
      npm(["publish", "--registry", registry], dir);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/401|403|unauth|forbidden|denied|E401|E403/i);
  });

  test("installing from a private repo without a token is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    // private is the default (visibility omitted)
    const repoName = `npm-err-private-${suffix}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: `npm-private-${suffix}` })).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    // publish with a valid token so the package genuinely exists
    const pkg = `e2e-private-${suffix}`;
    publishVersion(env, pkg, "1.0.0");

    // now consume with an .npmrc that names the registry but carries NO _authToken
    const registry = env.registry;
    const anonNpmrc = `registry=${registry}\n`;
    const dir = mkdtempSync(join(tmpdir(), "hoot-npm-private-anon-"));
    writeFileSync(join(dir, ".npmrc"), anonNpmrc);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", private: true }),
    );

    let failed = false;
    let message = "";
    try {
      npm(["install", `${pkg}@1.0.0`, "--registry", registry, "--no-audit", "--no-fund"], dir);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/401|403|unauth|forbidden|denied|E401|E403/i);
  });

  test("npm view on a nonexistent package fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const repoName = `npm-err-view-missing-${suffix}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).status(),
    ).toBe(201);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, { name: `npm-view-missing-${suffix}` })
      ).json()
    ).secret as string;
    const env = npmEnv(baseURL!, owner.orgSlug, repoName, secret);

    // empty repo: this package was never published
    const dir = mkdtempSync(join(tmpdir(), "hoot-npm-view-missing-"));
    writeFileSync(join(dir, ".npmrc"), env.npmrc);
    const missing = `e2e-view-absent-${suffix}`;

    let failed = false;
    let message = "";
    try {
      npm(["view", `${missing}@1.0.0`, "--registry", env.registry], dir);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/404|not found|E404/i);
  });
});
