import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { addMember, createRepo, createRepoReturning, createToken, setupOwner } from "./helpers";

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
          moduleId: "cargo",
          visibility: "public",
        })
      ).json()
    ).data as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
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
          moduleId: "cargo",
          visibility: "public",
        })
      ).json()
    ).data as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
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

interface CargoEnv {
  env: NodeJS.ProcessEnv;
  registryUrl: string;
}

/** Build the CARGO_HOME-backed env + sparse registry URL for a repo mountPath. */
function cargoEnv(baseURL: string, mountPath: string, token: string, prefix: string): CargoEnv {
  const registryUrl = `${dockerReachableUrl(baseURL)}/${mountPath}/`;
  const cargoHome = mkdtempSync(join(tmpdir(), prefix));
  return {
    registryUrl,
    env: {
      HOME: cargoHome,
      CARGO_HOME: cargoHome,
      CARGO_REGISTRIES_HOOTI_TOKEN: token,
      CARGO_TARGET_DIR: join(cargoHome, "target"),
    },
  };
}

/** Sparse-index shard for a crate name (len>=4 uses the two-level prefix). */
function cargoShard(name: string): string {
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

/** Publish a minimal library crate at `version` with optional extra Cargo.toml sections. */
function publishCrate(
  registryUrl: string,
  env: NodeJS.ProcessEnv,
  name: string,
  version: string,
  extraSections: string[] = [],
): void {
  const dir = mkdtempSync(join(tmpdir(), "hoot-cargo-x-pub-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeCargoConfig(dir, registryUrl);
  writeFileSync(
    join(dir, "Cargo.toml"),
    [
      "[package]",
      `name = "${name}"`,
      `version = "${version}"`,
      'edition = "2024"',
      'license = "MIT"',
      'description = "hootifactory e2e crate"',
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "",
      ...extraSections,
    ].join("\n"),
  );
  writeFileSync(join(dir, "src", "lib.rs"), 'pub fn hoot() -> &\'static str { "hoot" }\n');
  cargo(["publish", "--registry", "hooti", "--allow-dirty", "--no-verify"], dir, env);
}

/** Materialize a consumer crate that depends on `deps` lines, wired to `registryUrl`. */
function consumerCrate(registryUrl: string, depLines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hoot-cargo-x-consumer-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeCargoConfig(dir, registryUrl);
  writeFileSync(
    join(dir, "Cargo.toml"),
    [
      "[package]",
      'name = "consumer"',
      'version = "1.0.0"',
      'edition = "2024"',
      "",
      "[dependencies]",
      ...depLines,
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "src", "lib.rs"), "pub fn consumer() {}\n");
  return dir;
}

test.describe("cargo sparse registry extended scenarios (Dockerized real cargo)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("resolves semver range across multiple published versions", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-semver-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(
      baseURL!,
      repo.mountPath,
      token,
      "hoot-cargo-semver-home-",
    );

    const crate = `hootsemver${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    publishCrate(registryUrl, env, crate, "1.0.0");
    publishCrate(registryUrl, env, crate, "1.1.0");
    publishCrate(registryUrl, env, crate, "2.0.0");

    const consumer = consumerCrate(registryUrl, [
      `${crate} = { version = "^1.0.0", registry = "hooti" }`,
    ]);
    cargo(["generate-lockfile"], consumer, env);

    const lock = readFileSync(join(consumer, "Cargo.lock"), "utf8");
    expect(lock).toContain(`name = "${crate}"`);
    expect(lock).toContain('version = "1.1.0"');
    expect(lock).not.toContain('version = "2.0.0"');
  });

  test("yanked versions are excluded from new resolution", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-yank-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(baseURL!, repo.mountPath, token, "hoot-cargo-yank-home-");

    const crate = `hootyank${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    publishCrate(registryUrl, env, crate, "1.0.0");
    const pubDir = mkdtempSync(join(tmpdir(), "hoot-cargo-yank-pub-"));
    mkdirSync(join(pubDir, "src"), { recursive: true });
    writeCargoConfig(pubDir, registryUrl);
    publishCrate(registryUrl, env, crate, "1.1.0");

    cargo(["yank", crate, "--version", "1.1.0", "--registry", "hooti"], pubDir, env);
    const shard = cargoShard(crate);
    const indexText = await (await owner.ctx.get(`/${repo.mountPath}/${shard}`)).text();
    expect(indexText).toContain('"vers":"1.1.0"');
    expect(indexText).toContain('"yanked":true');

    const consumer = consumerCrate(registryUrl, [
      `${crate} = { version = "^1.0", registry = "hooti" }`,
    ]);
    cargo(["generate-lockfile"], consumer, env);

    const lock = readFileSync(join(consumer, "Cargo.lock"), "utf8");
    expect(lock).toContain(`name = "${crate}"`);
    expect(lock).toContain('version = "1.0.0"');
    expect(lock).not.toContain('version = "1.1.0"');
  });

  test("optional dependency gated behind a feature builds when the feature is enabled", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-feature-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(
      baseURL!,
      repo.mountPath,
      token,
      "hoot-cargo-feature-home-",
    );

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const depName = `hootfeatdep${id}`;
    const mainName = `hootfeatmain${id}`;

    publishCrate(registryUrl, env, depName, "1.0.0");
    publishCrate(registryUrl, env, mainName, "1.0.0", [
      "[dependencies]",
      `${depName} = { version = "1.0.0", registry = "hooti", optional = true }`,
      "",
      "[features]",
      `withdep = ["dep:${depName}"]`,
      "",
    ]);

    const mainShard = cargoShard(mainName);
    const mainIndexText = await (await owner.ctx.get(`/${repo.mountPath}/${mainShard}`)).text();
    const mainIndex = JSON.parse(mainIndexText.trim().split("\n")[0]!);
    const optionalDep = mainIndex.deps.find((d: { name: string }) => d.name === depName);
    expect(optionalDep).toMatchObject({ name: depName, optional: true });

    const consumer = consumerCrate(registryUrl, [
      `${mainName} = { version = "1.0.0", registry = "hooti", features = ["withdep"] }`,
    ]);
    cargo(["check"], consumer, env);
  });

  test("cargo owner add/list/remove round-trips through the owners API", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-owner-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(
      baseURL!,
      repo.mountPath,
      token,
      "hoot-cargo-owner-home-",
    );

    const crate = `hootowner${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const pubDir = mkdtempSync(join(tmpdir(), "hoot-cargo-owner-pub-"));
    mkdirSync(join(pubDir, "src"), { recursive: true });
    writeCargoConfig(pubDir, registryUrl);
    publishCrate(registryUrl, env, crate, "1.0.0");

    cargo(["owner", "--add", owner.username, "--registry", "hooti", crate], pubDir, env);
    const listed = cargo(["owner", "--list", "--registry", "hooti", crate], pubDir, env);
    expect(typeof listed).toBe("string");
    expect(listed.trim().length).toBeGreaterThan(0);
    cargo(["owner", "--remove", owner.username, "--registry", "hooti", crate], pubDir, env);
  });

  test("virtual repo resolves a crate published to a hosted member", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const member = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-virt-member-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const virtual = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-virt-cli",
      moduleId: "cargo",
      kind: "virtual",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;

    const memberEnv = cargoEnv(baseURL!, member.mountPath, token, "hoot-cargo-virt-member-home-");
    const crate = `hootvirt${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    publishCrate(memberEnv.registryUrl, memberEnv.env, crate, "1.0.0");

    expect((await addMember(owner.ctx, virtual.id, member.id, 0)).status()).toBe(201);

    const virtualEnv = cargoEnv(baseURL!, virtual.mountPath, token, "hoot-cargo-virt-home-");
    const consumer = consumerCrate(virtualEnv.registryUrl, [
      `${crate} = { version = "1.0.0", registry = "hooti" }`,
    ]);
    cargo(["fetch"], consumer, virtualEnv.env);

    const shard = cargoShard(crate);
    const virtualIndex = await (await owner.ctx.get(`/${virtual.mountPath}/${shard}`)).text();
    expect(virtualIndex).toContain('"vers":"1.0.0"');
  });
});

test.describe("cargo sparse registry error and edge scenarios (Dockerized real cargo)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("publishing an existing version is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-dup-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(baseURL!, repo.mountPath, token, "hoot-cargo-dup-home-");

    const crate = `hootdup${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    publishCrate(registryUrl, env, crate, "1.0.0");

    let failed = false;
    let message = "";
    try {
      publishCrate(registryUrl, env, crate, "1.0.0");
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/already|exists|conflict|409/i);
  });

  test("publishing without a token is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-noauth-cli",
      moduleId: "cargo",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(
      baseURL!,
      repo.mountPath,
      token,
      "hoot-cargo-noauth-home-",
    );
    // Drop the registry token so the publish carries no credentials at all.
    const { CARGO_REGISTRIES_HOOTI_TOKEN: _omitted, ...anonEnv } = env;

    const crate = `hootnoauth${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const dir = mkdtempSync(join(tmpdir(), "hoot-cargo-noauth-pub-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeCargoConfig(dir, registryUrl);
    writeFileSync(
      join(dir, "Cargo.toml"),
      [
        "[package]",
        `name = "${crate}"`,
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
    writeFileSync(join(dir, "src", "lib.rs"), 'pub fn hoot() -> &\'static str { "hoot" }\n');

    let failed = false;
    let message = "";
    try {
      cargo(["publish", "--registry", "hooti", "--allow-dirty", "--no-verify"], dir, anonEnv);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/token|unauthorized|denied|auth|401|403/i);
  });

  test("fetching a dependency on a nonexistent crate fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-missing-cli",
      moduleId: "cargo",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(
      baseURL!,
      repo.mountPath,
      token,
      "hoot-cargo-missing-home-",
    );

    // Nothing was ever published to this registry, so the dependency cannot resolve.
    const missing = `hootmissing${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const consumer = consumerCrate(registryUrl, [
      `${missing} = { version = "1.0.0", registry = "hooti" }`,
    ]);

    let failed = false;
    let message = "";
    try {
      cargo(["generate-lockfile"], consumer, env);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|no matching|does not exist|404|failed to/i);
  });

  test("depending on a nonexistent version of an existing crate fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "crates-badver-cli",
      moduleId: "cargo",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cargo" })).json()).data
      .secret as string;
    const { env, registryUrl } = cargoEnv(
      baseURL!,
      repo.mountPath,
      token,
      "hoot-cargo-badver-home-",
    );

    const crate = `hootbadver${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    publishCrate(registryUrl, env, crate, "1.0.0");

    // The crate exists, but 9.9.9 was never published, so exact resolution must fail.
    const consumer = consumerCrate(registryUrl, [
      `${crate} = { version = "=9.9.9", registry = "hooti" }`,
    ]);

    let failed = false;
    let message = "";
    try {
      cargo(["generate-lockfile"], consumer, env);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/no matching|not found|failed to select|9\.9\.9/i);
  });
});
