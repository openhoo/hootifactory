import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepo, createToken, setupOwner } from "./helpers";

function cargo(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.cargo, ["cargo", ...args], { cwd, env });
}

function writeCargoConfig(dir: string, registryUrl: string): void {
  const cargoDir = join(dir, ".cargo");
  mkdirSync(cargoDir, { recursive: true });
  writeFileSync(
    join(cargoDir, "config.toml"),
    `[registries.hooti]\nindex = "sparse+${registryUrl}"\n`,
  );
}

test.describe("cargo sparse registry (Dockerized real cargo)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("cargo publish -> cargo fetch from custom sparse registry", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "crates-cli",
          format: "cargo",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json())
      .secret as string;

    const registryUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}/`;
    const cargoHome = mkdtempSync(join(tmpdir(), "hoot-cargo-home-"));
    const env = {
      HOME: cargoHome,
      CARGO_HOME: cargoHome,
      CARGO_REGISTRIES_HOOTI_TOKEN: token,
      CARGO_TARGET_DIR: join(cargoHome, "target"),
    };

    const id = Date.now().toString(36);
    const crateName = `hootclicrate${id}`;
    const pubDir = mkdtempSync(join(tmpdir(), "hoot-cargo-pub-"));
    mkdirSync(join(pubDir, "src"), { recursive: true });
    writeCargoConfig(pubDir, registryUrl);
    writeFileSync(
      join(pubDir, "Cargo.toml"),
      [
        "[package]",
        `name = "${crateName}"`,
        'version = "1.0.0"',
        'edition = "2024"',
        'license = "MIT"',
        'description = "hootifactory e2e crate"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(pubDir, "src", "lib.rs"), 'pub fn hoot() -> &\'static str { "hoot" }\n');

    cargo(["publish", "--registry", "hooti", "--allow-dirty", "--no-verify"], pubDir, env);

    const consumer = mkdtempSync(join(tmpdir(), "hoot-cargo-consumer-"));
    mkdirSync(join(consumer, "src"), { recursive: true });
    writeCargoConfig(consumer, registryUrl);
    writeFileSync(
      join(consumer, "Cargo.toml"),
      [
        "[package]",
        'name = "consumer"',
        'version = "1.0.0"',
        'edition = "2024"',
        "",
        "[dependencies]",
        `${crateName} = { version = "1.0.0", registry = "hooti" }`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(consumer, "src", "lib.rs"), "pub fn consumer() {}\n");

    cargo(["fetch"], consumer, env);

    const indexPath = `${crateName.slice(0, 2)}/${crateName.slice(2, 4)}/${crateName}`;
    const indexText = await (await owner.ctx.get(`/${repo.mountPath}/${indexPath}`)).text();
    expect(indexText).toContain('"vers":"1.0.0"');

    cargo(["yank", crateName, "--version", "1.0.0", "--registry", "hooti"], pubDir, env);
    const yanked = await (await owner.ctx.get(`/${repo.mountPath}/${indexPath}`)).text();
    expect(yanked).toContain('"yanked":true');

    cargo(["yank", crateName, "--version", "1.0.0", "--registry", "hooti", "--undo"], pubDir, env);
    const unyanked = await (await owner.ctx.get(`/${repo.mountPath}/${indexPath}`)).text();
    expect(unyanked).toContain('"yanked":false');
  });

  test("cargo publish preserves renamed registry dependencies for real cargo resolution", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "crates-deps-cli",
          format: "cargo",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json())
      .secret as string;

    const registryUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}/`;
    const cargoHome = mkdtempSync(join(tmpdir(), "hoot-cargo-deps-home-"));
    const env = {
      HOME: cargoHome,
      CARGO_HOME: cargoHome,
      CARGO_REGISTRIES_HOOTI_TOKEN: token,
      CARGO_TARGET_DIR: join(cargoHome, "target"),
    };

    const id = Date.now().toString(36);
    const depName = `hootclidep${id}`;
    const mainName = `hootclimain${id}`;

    const depDir = mkdtempSync(join(tmpdir(), "hoot-cargo-dep-"));
    mkdirSync(join(depDir, "src"), { recursive: true });
    writeCargoConfig(depDir, registryUrl);
    writeFileSync(
      join(depDir, "Cargo.toml"),
      [
        "[package]",
        `name = "${depName}"`,
        'version = "1.0.0"',
        'edition = "2024"',
        'license = "MIT"',
        'description = "hootifactory dependency crate"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(depDir, "src", "lib.rs"), 'pub fn dep_value() -> &\'static str { "dep" }\n');
    cargo(["publish", "--registry", "hooti", "--allow-dirty", "--no-verify"], depDir, env);

    const mainDir = mkdtempSync(join(tmpdir(), "hoot-cargo-main-"));
    mkdirSync(join(mainDir, "src"), { recursive: true });
    writeCargoConfig(mainDir, registryUrl);
    writeFileSync(
      join(mainDir, "Cargo.toml"),
      [
        "[package]",
        `name = "${mainName}"`,
        'version = "1.0.0"',
        'edition = "2024"',
        'license = "MIT"',
        'description = "hootifactory dependent crate"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
        "[dependencies]",
        `dep_alias = { package = "${depName}", version = "1.0.0", registry = "hooti" }`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(mainDir, "src", "lib.rs"),
      "pub fn main_value() -> &'static str { dep_alias::dep_value() }\n",
    );
    cargo(["publish", "--registry", "hooti", "--allow-dirty", "--no-verify"], mainDir, env);

    const mainIndexPath = `${mainName.slice(0, 2)}/${mainName.slice(2, 4)}/${mainName}`;
    const mainIndexText = await (await owner.ctx.get(`/${repo.mountPath}/${mainIndexPath}`)).text();
    const mainIndex = JSON.parse(mainIndexText.trim().split("\n")[0]!);
    expect(mainIndex.deps[0]).toMatchObject({
      name: "dep_alias",
      package: depName,
      req: "^1.0.0",
    });

    const consumer = mkdtempSync(join(tmpdir(), "hoot-cargo-deps-consumer-"));
    mkdirSync(join(consumer, "src"), { recursive: true });
    writeCargoConfig(consumer, registryUrl);
    writeFileSync(
      join(consumer, "Cargo.toml"),
      [
        "[package]",
        'name = "consumer"',
        'version = "1.0.0"',
        'edition = "2024"',
        "",
        "[dependencies]",
        `${mainName} = { version = "1.0.0", registry = "hooti" }`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "src", "lib.rs"),
      `pub fn consumer() -> &'static str { ${mainName}::main_value() }\n`,
    );

    cargo(["check"], consumer, env);
  });
});
