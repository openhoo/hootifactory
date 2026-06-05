import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

function gem(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.ruby, ["gem", ...args], { cwd, env });
}

function bundle(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.ruby, ["bundle", ...args], { cwd, env });
}

function writeGemProject(dir: string, name: string): void {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", `${name}.rb`), `module ${name.replace(/[^A-Za-z]/g, "")}\nend\n`);
  writeFileSync(
    join(dir, `${name}.gemspec`),
    [
      "Gem::Specification.new do |s|",
      `  s.name = "${name}"`,
      '  s.version = "1.0.0"',
      '  s.summary = "hootifactory e2e gem"',
      '  s.authors = ["e2e"]',
      `  s.files = ["lib/${name}.rb"]`,
      "end",
      "",
    ].join("\n"),
  );
}

function writeGemCredentials(home: string, apiKey: string): void {
  mkdirSync(join(home, ".gem"), { recursive: true });
  writeFileSync(join(home, ".gem", "credentials"), `---\n:rubygems_api_key: ${apiKey}\n`, {
    mode: 0o600,
  });
}

test.describe("rubygems registry (Dockerized real gem)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("gem push -> bundle install round-trips through the compact index", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "gems-cli",
      moduleId: "rubygems",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "rubygems" })).json())
      .secret as string;

    const source = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const id = Date.now().toString(36);
    const name = `hootgem${id}`;
    const gemFile = `${name}-1.0.0.gem`;

    const pushHome = mkdtempSync(join(tmpdir(), "hoot-gem-push-"));
    writeGemProject(pushHome, name);
    writeGemCredentials(pushHome, token);
    const pushEnv = { HOME: pushHome, GEM_HOME: join(pushHome, ".gemhome") };

    gem(["build", `${name}.gemspec`], pushHome, pushEnv);
    gem(["push", gemFile, "--host", source], pushHome, pushEnv);

    // The compact-index `/info/<gem>` document must carry the version and its checksum.
    const info = await owner.ctx.get(`/${repo.mountPath}/info/${name}`);
    expect(info.status()).toBe(200);
    const infoText = await info.text();
    expect(infoText).toContain("1.0.0 |checksum:");
    const versions = await (await owner.ctx.get(`/${repo.mountPath}/versions`)).text();
    expect(versions).toContain(`${name} 1.0.0 `);

    // Bundler is the client that consumes the compact index (`/versions`, `/info`);
    // it resolves from `/info/<gem>` and verifies the download against its checksum.
    const consumerHome = mkdtempSync(join(tmpdir(), "hoot-bundle-"));
    writeFileSync(join(consumerHome, "Gemfile"), `source "${source}/"\ngem "${name}", "1.0.0"\n`);
    bundle(["install"], consumerHome, {
      HOME: consumerHome,
      BUNDLE_PATH: join(consumerHome, "vendor"),
      GEM_HOME: join(consumerHome, ".gemhome"),
    });
    const lock = readFileSync(join(consumerHome, "Gemfile.lock"), "utf8");
    expect(lock).toContain(`${name} (1.0.0)`);
  });

  test("gem push rejects an invalid api key", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "gems-cli-auth",
      moduleId: "rubygems",
      visibility: "public",
    });

    const source = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const name = `hootgemauth${Date.now().toString(36)}`;
    const home = mkdtempSync(join(tmpdir(), "hoot-gem-auth-"));
    writeGemProject(home, name);
    writeGemCredentials(home, "hoot_invalidtoken");
    const env = { HOME: home, GEM_HOME: join(home, ".gemhome") };

    gem(["build", `${name}.gemspec`], home, env);
    expect(() => gem(["push", `${name}-1.0.0.gem`, "--host", source], home, env)).toThrow();
  });
});
