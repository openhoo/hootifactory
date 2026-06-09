import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const playwrightBin = join(repoRoot, "node_modules", ".bin", "playwright");

if (!existsSync(playwrightBin)) {
  throw new Error("Playwright is not installed. Run `bun install` first.");
}

const env = {
  ...process.env,
  FORCE_COLOR: "0",
  NO_COLOR: "",
  NODE_OPTIONS: withDisabledWarning(process.env.NODE_OPTIONS, "DEP0205"),
};
const args = process.argv.slice(2);

if (args[0] === "test") {
  const setup = Bun.spawnSync(
    ["bun", "-e", 'import setup from "./tests/global-setup"; await setup();'],
    {
      cwd: repoRoot,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (setup.exitCode !== 0) {
    process.exit(setup.exitCode ?? 1);
  }
}

const proc = Bun.spawn([playwrightBin, ...args], {
  cwd: repoRoot,
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);

function withDisabledWarning(value: string | undefined, code: string): string {
  const option = `--disable-warning=${code}`;
  if (!value || value.trim() === "") {
    return option;
  }
  return value.split(/\s+/).includes(option) ? value : `${value} ${option}`;
}
