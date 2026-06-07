/**
 * Per-package unit-test coverage gate.
 *
 * `bun run test:unit` runs each package's `test:unit` with `cwd` set to that
 * package, so every package emits its OWN `coverage/lcov.info` (see
 * scripts/package-tests.ts). This script measures EACH package independently
 * against its own `src/` files and fails the build if ANY package's line
 * coverage drops below a threshold (default 80%, override with
 * COVERAGE_THRESHOLD or --threshold). There is no repo-wide aggregate: each
 * package must test itself.
 *
 * Two things make a package's number honest:
 *   1. A package is measured only on lines belonging to its OWN `src/`. When a
 *      package's tests load a file from another package (e.g. ../types/src), Bun
 *      records it in that package's lcov; we discard those cross-package records
 *      so a package can't borrow coverage from code it merely imports. This is
 *      exactly what enforces "each package tests itself".
 *   2. Bun's lcov only lists files a test actually loaded, so untested files in a
 *      package would silently vanish from its denominator. We therefore enumerate
 *      every source file under the package's `src/` and count any that never
 *      appear in its coverage as fully uncovered (0%). Without this, new untested
 *      code could pass the gate.
 *
 * Excluded from every package's denominator: tests, generated code (*.gen.ts,
 * *.d.ts), migrations, dist/node_modules. Whole packages can be excluded via
 * EXCLUDED_PACKAGES (apps/web is excluded — it is covered by Playwright e2e, not
 * unit tests). Extend exclusions with COVERAGE_EXCLUDE (comma-separated
 * substrings/regex fragments matched against the repo-relative path).
 *
 * The default --metric=lines is what CI gates on and is the metric that counts
 * untested files as 0%. --metric=functions is informational and reflects only
 * files that tests loaded (Bun emits no per-function data for untested files).
 *
 *   bun run scripts/coverage-gate.ts [--threshold=80] [--metric=lines|functions]
 */

import type { Dirent } from "node:fs";
import { appendFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type Metric = "lines" | "functions";

interface FileCoverage {
  lines: Map<number, number>;
  // Bun's lcov only emits aggregate FNF/FNH (functions found/hit) per record, not
  // per-function FN/FNDA. We take the max across records for the same file.
  fnFound: number;
  fnHit: number;
  // Set only for source files that never appeared in the package's lcov report:
  // their approximate executable-line count, all counted as uncovered.
  injected?: number;
}

interface PackageSummary {
  name: string; // repo-relative package dir, e.g. "packages/core"
  totalLines: number;
  coveredLines: number;
  linePct: number;
  totalFuncs: number;
  coveredFuncs: number;
  functionPct: number;
  // Per-file detail, sorted worst-first, used to surface failing files.
  files: FileSummary[];
  // True when the package has no measurable runtime lines (pure type/barrel
  // package). Such packages always pass. Keyed off lines (the authoritative
  // "has runtime code" signal) for BOTH metrics, so the informational functions
  // metric can't falsely pass a package that has uncovered lines but happens to
  // expose no instrumented functions.
  noMeasurableCode: boolean;
  passed: boolean;
}

interface FileSummary {
  file: string; // repo-relative source path
  totalLines: number;
  coveredLines: number;
  linePct: number;
}

const repoRoot = resolve(import.meta.dir, "..");
const DEFAULT_COVERAGE_THRESHOLD = 80;
const threshold = parseThreshold();
const metric = parseMetric();

// Whole packages excluded from the gate. apps/web is covered by Playwright e2e,
// not unit tests, so it must never appear in the per-package report.
const EXCLUDED_PACKAGES = new Set<string>(["apps/web"]);

// Files that should never count toward coverage (tests, generated code, type
// declarations, migrations). Bun already skips most test files, but we
// belt-and-suspenders it here so the number stays meaningful and stable, and so
// both the lcov-derived and enumerated file sets agree. (apps/web is excluded as
// a whole package via EXCLUDED_PACKAGES, not here.)
const IGNORE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /\.gen\.ts$/,
  /(^|\/)migrations\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  ...extraExcludes(),
];

// Where hand-written source lives, and what counts as a source file.
const SOURCE_ROOTS = ["apps", "packages"];
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo", ".vite"]);

const packageDirs = await findPackages();

if (packageDirs.length === 0) {
  fail(
    "No packages with a src/ directory found under apps/* or packages/*. " +
      "Run `bun run test:unit` first (it writes per-package coverage reports).",
  );
}

let sawAnyLcov = false;
const summaries: PackageSummary[] = [];
for (const pkgRel of packageDirs) {
  const summary = await measurePackage(pkgRel);
  summaries.push(summary);
}

if (!sawAnyLcov) {
  fail(
    "No coverage/lcov.info files found for any package. Run `bun run test:unit` " +
      "first (it writes a per-package coverage report this gate reads).",
  );
}

// Worst-first ordering: failing packages bubble to the top.
summaries.sort((a, b) => {
  const aVal = metric === "functions" ? a.functionPct : a.linePct;
  const bVal = metric === "functions" ? b.functionPct : b.linePct;
  return aVal - bVal || a.name.localeCompare(b.name);
});

const allPassed = summaries.every((s) => s.passed);

report(summaries, allPassed);

process.exit(allPassed ? 0 : 1);

// --- measurement ---------------------------------------------------------

async function measurePackage(pkgRel: string): Promise<PackageSummary> {
  const pkgDir = join(repoRoot, pkgRel);
  const srcPrefix = `${pkgRel}/src/`;
  const files = new Map<string, FileCoverage>();

  // 1. Parse the package's own lcov, keeping only records under <pkg>/src.
  const lcovPath = join(pkgDir, "coverage", "lcov.info");
  if (await exists(lcovPath)) {
    sawAnyLcov = true;
    parseLcov(await readFile(lcovPath, "utf8"), pkgDir, srcPrefix, files);
  }

  // 2. Enumerate the package's own src/** and inject any untested files as 0%.
  for (const abs of await findSourceFiles(pkgDir)) {
    const rel = relative(repoRoot, abs).split("\\").join("/");
    if (isIgnored(rel) || files.has(rel)) {
      continue;
    }
    const content = await readFile(abs, "utf8");
    // Declaration-only modules (pure type/interface) compile to no runtime code;
    // Bun reports them as LF=0 and we drop those, so skip them here too instead
    // of counting type lines as uncovered.
    if (!hasRuntimeCode(content)) {
      continue;
    }
    const lineCount = countCodeLines(content);
    if (lineCount > 0) {
      files.set(rel, { lines: new Map(), fnFound: 0, fnHit: 0, injected: lineCount });
    }
  }

  // 3. Compute per-file and package totals.
  const fileSummaries = summarizeFiles(files);
  let totalLines = 0;
  let coveredLines = 0;
  for (const s of fileSummaries) {
    totalLines += s.totalLines;
    coveredLines += s.coveredLines;
  }
  let totalFuncs = 0;
  let coveredFuncs = 0;
  for (const cov of files.values()) {
    totalFuncs += cov.fnFound;
    coveredFuncs += cov.fnHit;
  }

  const linePct = totalLines === 0 ? 100 : (coveredLines / totalLines) * 100;
  const functionPct = totalFuncs === 0 ? 100 : (coveredFuncs / totalFuncs) * 100;
  // A package "has no measurable code" only when it has zero executable lines
  // (pure type/barrel package). We key off lines for both metrics on purpose: a
  // package can have uncovered runtime lines yet zero instrumented functions
  // (e.g. only top-level statements), and we must not let the functions metric
  // treat that as "nothing to measure" and auto-pass it.
  const noMeasurableCode = totalLines === 0;

  // Integer-safe comparison so a threshold like 80 isn't tripped by float error.
  let passed: boolean;
  if (noMeasurableCode) {
    passed = true;
  } else if (metric === "functions") {
    passed = coveredFuncs * 100 >= threshold * totalFuncs - 1e-9;
  } else {
    passed = coveredLines * 100 >= threshold * totalLines - 1e-9;
  }

  return {
    name: pkgRel,
    totalLines,
    coveredLines,
    linePct,
    totalFuncs,
    coveredFuncs,
    functionPct,
    files: fileSummaries,
    noMeasurableCode,
    passed,
  };
}

function summarizeFiles(files: Map<string, FileCoverage>): FileSummary[] {
  const out: FileSummary[] = [];
  for (const [file, cov] of files) {
    // Measured files use Bun's instrumented lines; injected (untested) files use
    // their approximate executable-line count, all uncovered.
    const measured = cov.lines.size;
    const totalLines = measured > 0 ? measured : (cov.injected ?? 0);
    if (totalLines === 0) {
      continue;
    }
    let coveredLines = 0;
    for (const hits of cov.lines.values()) {
      if (hits > 0) {
        coveredLines += 1;
      }
    }
    out.push({
      file,
      totalLines,
      coveredLines,
      linePct: (coveredLines / totalLines) * 100,
    });
  }
  return out.sort((a, b) => a.linePct - b.linePct || a.file.localeCompare(b.file));
}

// --- parsing -------------------------------------------------------------

function parseLcov(
  content: string,
  packageDir: string,
  srcPrefix: string,
  files: Map<string, FileCoverage>,
): void {
  let current: FileCoverage | null = null;

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("SF:")) {
      const rel = toRepoRelative(packageDir, line.slice(3));
      // Keep ONLY this package's own src files. Cross-package spillover (code
      // this package imported but does not own) and non-src files are dropped.
      if (!rel.startsWith(srcPrefix) || isIgnored(rel)) {
        current = null;
        continue;
      }
      current = files.get(rel) ?? { lines: new Map(), fnFound: 0, fnHit: 0 };
      files.set(rel, current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("DA:")) {
      const comma = line.indexOf(",", 3);
      const lineNo = Number(line.slice(3, comma));
      const hits = Number(line.slice(comma + 1));
      if (Number.isFinite(lineNo)) {
        current.lines.set(lineNo, Math.max(current.lines.get(lineNo) ?? 0, hits));
      }
    } else if (line.startsWith("FNF:")) {
      current.fnFound = Math.max(current.fnFound, Number(line.slice(4)) || 0);
    } else if (line.startsWith("FNH:")) {
      current.fnHit = Math.max(current.fnHit, Number(line.slice(4)) || 0);
    } else if (line === "end_of_record") {
      current = null;
    }
  }
}

function toRepoRelative(packageDir: string, sourcePath: string): string {
  const rel = relative(repoRoot, resolve(packageDir, sourcePath));
  return rel.split("\\").join("/");
}

function isIgnored(relPath: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(relPath));
}

// --- reporting -----------------------------------------------------------

function pkgValue(s: PackageSummary): number {
  return metric === "functions" ? s.functionPct : s.linePct;
}

function pkgCovered(s: PackageSummary): number {
  return metric === "functions" ? s.coveredFuncs : s.coveredLines;
}

function pkgTotal(s: PackageSummary): number {
  return metric === "functions" ? s.totalFuncs : s.totalLines;
}

function report(summaries: PackageSummary[], passed: boolean): void {
  const failing = summaries.filter((s) => !s.passed);

  console.log("");
  console.log(`Per-package coverage gate (${metric} ≥ ${threshold}% each)`);
  console.log("──────────────────────────────────────────────────────────");
  console.log(
    `${"Package".padEnd(34)} ${"Cov".padStart(8)}  ${"Covered/Total".padStart(15)}  Status`,
  );
  for (const s of summaries) {
    const label = s.noMeasurableCode ? "  n/a  " : fmtPct(pkgValue(s));
    const covered = s.noMeasurableCode ? "no measurable code" : `${pkgCovered(s)}/${pkgTotal(s)}`;
    const status = s.passed ? "PASS" : "FAIL";
    console.log(`${s.name.padEnd(34)} ${label.padStart(8)}  ${covered.padStart(15)}  ${status}`);
  }

  console.log("");
  console.log(`Packages measured: ${summaries.length}  (failing: ${failing.length})`);

  for (const s of failing) {
    const worst = s.files.filter((f) => f.linePct < 100).slice(0, 10);
    if (worst.length === 0) {
      continue;
    }
    console.log("");
    console.log(`${s.name} — lowest-covered files:`);
    for (const f of worst) {
      console.log(`  ${fmtPct(f.linePct)}  ${f.coveredLines}/${f.totalLines}  ${f.file}`);
    }
  }

  console.log("");
  if (passed) {
    console.log(`✔ PASS: every package meets the ${threshold}% ${metric} floor.`);
  } else {
    const names = failing.map((s) => s.name).join(", ");
    console.log(
      `✖ FAIL: ${failing.length} package(s) below the ${threshold}% ${metric} floor: ${names}.`,
    );
  }

  writeStepSummary(summaries, passed);
}

function writeStepSummary(summaries: PackageSummary[], passed: boolean): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const failing = summaries.filter((s) => !s.passed);
  const lines: string[] = [
    `## ${passed ? "✅" : "❌"} Per-package coverage gate — ${metric} ≥ ${threshold}% each`,
    "",
    passed
      ? `All ${summaries.length} packages meet the ${threshold}% floor.`
      : `${failing.length} of ${summaries.length} packages are below the ${threshold}% floor.`,
    "",
    "| Package | Coverage | Covered / Total | Status |",
    "| --- | --- | --- | --- |",
  ];
  for (const s of summaries) {
    const cov = s.noMeasurableCode ? "n/a" : fmtPct(pkgValue(s));
    const total = s.noMeasurableCode ? "no measurable code" : `${pkgCovered(s)} / ${pkgTotal(s)}`;
    const status = s.passed ? "✅ PASS" : "❌ FAIL";
    lines.push(`| \`${s.name}\` | ${cov} | ${total} | ${status} |`);
  }

  for (const s of failing) {
    const worst = s.files.filter((f) => f.linePct < 100).slice(0, 10);
    if (worst.length === 0) {
      continue;
    }
    lines.push(
      "",
      `<details><summary><code>${s.name}</code> — lowest-covered files</summary>`,
      "",
      "| Coverage | File |",
      "| --- | --- |",
    );
    for (const f of worst) {
      lines.push(`| ${fmtPct(f.linePct)} (${f.coveredLines}/${f.totalLines}) | \`${f.file}\` |`);
    }
    lines.push("", "</details>");
  }
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

// --- discovery -----------------------------------------------------------

// Packages = repo-relative dirs under apps/* and packages/* that contain a src/
// directory, minus EXCLUDED_PACKAGES. Dirs without src/ are skipped entirely.
async function findPackages(): Promise<string[]> {
  const found: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const rootDir = join(repoRoot, root);
    let entries: Dirent[];
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgRel = `${root}/${entry.name}`;
      if (EXCLUDED_PACKAGES.has(pkgRel)) {
        continue;
      }
      if (await isDirectory(join(rootDir, entry.name, "src"))) {
        found.push(pkgRel);
      }
    }
  }
  return found.sort();
}

async function findSourceFiles(packageDir: string): Promise<string[]> {
  const found: string[] = [];
  await walkSource(join(packageDir, "src"), found);
  return found;
}

async function walkSource(dir: string, found: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walkSource(path, found);
      }
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      found.push(path);
    }
  }
}

// Whether a file has any runtime-producing code (value declarations or
// executable statements) versus being declaration-only (types/interfaces, which
// Bun instruments as zero lines). Used to decide whether an untested file should
// count against coverage at all. Errs toward "has runtime" (conservative).
function hasRuntimeCode(content: string): boolean {
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("//") || line.startsWith("*")) {
      continue;
    }
    if (/\b(const|let|var|function|class|enum)\b/.test(line)) {
      return true;
    }
    if (/^export\s+(default\b|[*{])/.test(line)) {
      return true; // default export, value re-export, or barrel
    }
  }
  return false;
}

// Approximate executable lines for a file Bun never instrumented: non-blank
// lines that aren't pure comments or lone punctuation. Used only as the
// denominator weight for untested files (which are 0% covered regardless).
function countCodeLines(content: string): number {
  const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, "");
  let count = 0;
  for (const raw of withoutBlockComments.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("//") || line.startsWith("*")) {
      continue;
    }
    if (/^[{}()[\];,]+$/.test(line)) {
      continue;
    }
    count += 1;
  }
  return count;
}

function extraExcludes(): RegExp[] {
  const raw = process.env.COVERAGE_EXCLUDE?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        return new RegExp(part);
      } catch {
        return fail(`Invalid COVERAGE_EXCLUDE pattern: ${part}`);
      }
    });
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// --- args / helpers ------------------------------------------------------

function parseThreshold(): number {
  const fromArg = getArgValue("--threshold");
  // Treat empty/whitespace env as "use default" so COVERAGE_THRESHOLD="" can't
  // silently become 0% (which would pass everything).
  const raw =
    (fromArg ?? process.env.COVERAGE_THRESHOLD ?? "").trim() || String(DEFAULT_COVERAGE_THRESHOLD);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    fail(`Invalid coverage threshold: ${raw} (expected a number between 0 and 100).`);
  }
  return value;
}

function parseMetric(): Metric {
  const raw = (
    (getArgValue("--metric") ?? process.env.COVERAGE_METRIC ?? "").trim() || "lines"
  ).toLowerCase();
  if (raw !== "lines" && raw !== "functions") {
    fail(`Invalid coverage metric: ${raw} (expected "lines" or "functions").`);
  }
  return raw;
}

function getArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) {
    return eq.slice(name.length + 1);
  }
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}
