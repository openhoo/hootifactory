import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

type TestMode = "unit" | "integration";

const mode = parseMode(process.argv[2]);
const extraArgs = process.argv.slice(3);
const cwd = process.cwd();
const packageName = await readPackageName(cwd);

const testFiles = (await findTestFiles(cwd)).filter((file) =>
  mode === "integration" ? isIntegrationTest(file) : !isIntegrationTest(file),
);

if (testFiles.length === 0) {
  console.log(`${packageName}: no ${mode} tests found`);
  process.exit(0);
}

const args = ["test"];
if (mode === "unit" && !extraArgs.includes("--watch")) {
  args.push("--parallel");
}
args.push(...extraArgs, ...testFiles.map((file) => relative(cwd, file)));

const proc = Bun.spawn(["bun", ...args], {
  cwd,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

process.exit(await proc.exited);

function parseMode(value: string | undefined): TestMode {
  if (value === "unit" || value === "integration") {
    return value;
  }
  throw new Error(`Usage: bun run scripts/package-tests.ts <unit|integration> [...bun test args]`);
}

async function readPackageName(packageDir: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    name?: string;
  };
  return packageJson.name ?? (relative(process.cwd(), packageDir) || packageDir);
}

async function findTestFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files.filter(isTestFile).sort();
}

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) {
        continue;
      }
      await walk(path, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
}

function shouldSkipDir(name: string): boolean {
  return ["node_modules", "dist", "build", "coverage", ".turbo", ".vite"].includes(name);
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isIntegrationTest(file: string): boolean {
  return /\.integration\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}
