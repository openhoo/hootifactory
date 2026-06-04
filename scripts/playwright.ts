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

const proc = Bun.spawn([playwrightBin, ...process.argv.slice(2)], {
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
