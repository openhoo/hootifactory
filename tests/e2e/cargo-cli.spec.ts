import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

function available(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cargo(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("cargo", args, {
      cwd,
      env,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error(`cargo ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

function writeCargoConfig(dir: string, registryUrl: string): void {
  const cargoDir = join(dir, ".cargo");
  mkdirSync(cargoDir, { recursive: true });
  writeFileSync(
    join(cargoDir, "config.toml"),
    `[registries.hooti]\nindex = "sparse+${registryUrl}"\n`,
  );
}

test.describe("cargo sparse registry (real cargo)", () => {
  test.skip(!available("cargo", ["--version"]), "cargo missing");

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

    const registryUrl = `${baseURL}/${repo.mountPath}/`;
    const cargoHome = mkdtempSync(join(tmpdir(), "hoot-cargo-home-"));
    const env = {
      ...process.env,
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
  });
});
