/**
 * Repo-wide unit-test coverage gate.
 *
 * `bun run test:unit` already emits a per-package `coverage/lcov.info` (see
 * scripts/package-tests.ts). This script merges every one of those reports into
 * a single repo-wide number and fails the build when line coverage drops below a
 * threshold (default 60%, override with COVERAGE_THRESHOLD or --threshold).
 *
 * Two things make the number honest:
 *   1. Merging is done *by source file*, not by summing per-package totals: a
 *      file imported across packages (e.g. ../types/src/index.ts shows up in many
 *      reports) would otherwise be counted once per importer. We union the
 *      executions — a line counts as covered if any package's tests hit it.
 *   2. Bun's lcov only lists files a test actually loaded, so untested files
 *      would silently vanish from the denominator. We therefore enumerate every
 *      source file under apps/<pkg>/src and packages/<pkg>/src and count any that
 *      never appear in coverage as fully uncovered (0%). Without this, new
 *      untested code could pass the gate.
 *
 * Excluded from the denominator: tests, generated code (*.gen.ts, *.d.ts),
 * migrations, dist/node_modules, and apps/web (which is covered by Playwright
 * e2e, not unit tests). Extend exclusions with COVERAGE_EXCLUDE (comma-separated
 * substrings/regex fragments matched against the repo-relative path).
 *
 * The default --metric=lines is what CI gates on and is the metric that counts
 * untested files as 0%. --metric=functions is informational and reflects only
 * files that tests loaded (Bun emits no per-function data for untested files).
 *
 *   bun run scripts/coverage-gate.ts [--threshold=60] [--metric=lines|functions]
 */

import type { Dirent } from "node:fs";
import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

type Metric = "lines" | "functions";

interface FileCoverage {
  lines: Map<number, number>;
  // Bun's lcov only emits aggregate FNF/FNH (functions found/hit) per record, not
  // per-function FN/FNDA. We take the max across packages: FNF is identical for a
  // shared file, and max(FNH) approximates "hit by any package's tests".
  fnFound: number;
  fnHit: number;
  // Set only for source files that never appeared in any lcov report: their
  // approximate executable-line count, all counted as uncovered.
  injected?: number;
}

interface FileSummary {
  file: string;
  totalLines: number;
  coveredLines: number;
  linePct: number;
}

const repoRoot = resolve(import.meta.dir, "..");
const DEFAULT_COVERAGE_THRESHOLD = 60;
const threshold = parseThreshold();
const metric = parseMetric();

// Files that should never count toward coverage (tests, generated code, type
// declarations, migrations, and the e2e-tested web UI). Bun already skips most
// test files, but we belt-and-suspenders it here so the number stays meaningful
// and stable, and so both the lcov-derived and enumerated file sets agree.
const IGNORE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /\.gen\.ts$/,
  /(^|\/)migrations\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /^apps\/web\//,
  ...extraExcludes(),
];

// Where hand-written source lives, and what counts as a source file.
const SOURCE_ROOTS = ["apps", "packages"];
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo", ".vite"]);

const lcovFiles = await findLcovFiles();

if (lcovFiles.length === 0) {
  fail(
    "No coverage/lcov.info files found. Run `bun run test:unit` first " +
      "(it writes per-package coverage reports that this gate aggregates).",
  );
}

const files = new Map<string, FileCoverage>();
for (const lcovPath of lcovFiles) {
  // <pkg>/coverage/lcov.info -> <pkg>; SF paths are relative to that package dir.
  const packageDir = dirname(dirname(lcovPath));
  parseLcov(await readFile(lcovPath, "utf8"), packageDir);
}

// Whole-tree honesty: any source file that no test loaded is absent from lcov.
// Enumerate the source tree and inject those as fully uncovered so untested code
// counts against the threshold.
let injectedFiles = 0;
for (const abs of await findSourceFiles()) {
  const rel = relative(repoRoot, abs).split("\\").join("/");
  if (isIgnored(rel) || files.has(rel)) {
    continue;
  }
  const content = await readFile(abs, "utf8");
  // Declaration-only modules (pure type/interface) compile to no runtime code;
  // Bun reports them as LF=0 and we drop those, so skip them here too instead of
  // counting type lines as uncovered (which would make a type file's weight depend
  // on whether some unrelated test happened to import it).
  if (!hasRuntimeCode(content)) {
    continue;
  }
  const lineCount = countCodeLines(content);
  if (lineCount > 0) {
    files.set(rel, { lines: new Map(), fnFound: 0, fnHit: 0, injected: lineCount });
    injectedFiles += 1;
  }
}

const summaries = summarize();
if (summaries.length === 0) {
  fail("Coverage reports contained no measurable source files.");
}

const totals = computeTotals(summaries);
const value = metric === "functions" ? totals.functionPct : totals.linePct;
// Integer-safe comparison so a threshold like 80 isn't tripped by float error.
const passed =
  metric === "functions"
    ? totals.coveredFuncs * 100 >= threshold * totals.totalFuncs - 1e-9
    : totals.coveredLines * 100 >= threshold * totals.totalLines - 1e-9;

report(summaries, totals, value, passed);

process.exit(passed ? 0 : 1);

// --- parsing -------------------------------------------------------------

function parseLcov(content: string, packageDir: string): void {
  let current: FileCoverage | null = null;

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("SF:")) {
      const rel = toRepoRelative(packageDir, line.slice(3));
      if (isIgnored(rel)) {
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

// --- aggregation ---------------------------------------------------------

function summarize(): FileSummary[] {
  const summaries: FileSummary[] = [];
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
    summaries.push({
      file,
      totalLines,
      coveredLines,
      linePct: (coveredLines / totalLines) * 100,
    });
  }
  return summaries.sort((a, b) => a.linePct - b.linePct || a.file.localeCompare(b.file));
}

function computeTotals(summaries: FileSummary[]) {
  let totalLines = 0;
  let coveredLines = 0;
  for (const summary of summaries) {
    totalLines += summary.totalLines;
    coveredLines += summary.coveredLines;
  }

  let totalFuncs = 0;
  let coveredFuncs = 0;
  for (const cov of files.values()) {
    totalFuncs += cov.fnFound;
    coveredFuncs += cov.fnHit;
  }

  return {
    totalLines,
    coveredLines,
    linePct: totalLines === 0 ? 0 : (coveredLines / totalLines) * 100,
    totalFuncs,
    coveredFuncs,
    functionPct: totalFuncs === 0 ? 0 : (coveredFuncs / totalFuncs) * 100,
  };
}

// --- reporting -----------------------------------------------------------

function report(
  summaries: FileSummary[],
  totals: ReturnType<typeof computeTotals>,
  value: number,
  passed: boolean,
): void {
  const status = passed ? "PASS" : "FAIL";
  const worst = summaries.filter((s) => s.linePct < 100).slice(0, 15);

  console.log("");
  console.log(`Coverage gate (${metric} ≥ ${threshold}%)`);
  console.log("────────────────────────────────────────────");
  console.log(
    `Lines:     ${fmtPct(totals.linePct)}  (${totals.coveredLines}/${totals.totalLines})`,
  );
  if (totals.totalFuncs > 0) {
    console.log(
      `Functions: ${fmtPct(totals.functionPct)}  (${totals.coveredFuncs}/${totals.totalFuncs})`,
    );
  }
  console.log(`Files measured: ${summaries.length} (${injectedFiles} untested, counted as 0%)`);

  if (worst.length > 0) {
    console.log("");
    console.log("Lowest-covered files:");
    for (const s of worst) {
      console.log(`  ${fmtPct(s.linePct)}  ${s.coveredLines}/${s.totalLines}  ${s.file}`);
    }
  }

  console.log("");
  console.log(
    passed
      ? `✔ ${status}: ${metric} coverage ${fmtPct(value)} meets the ${threshold}% threshold.`
      : `✖ ${status}: ${metric} coverage ${fmtPct(value)} is below the ${threshold}% threshold.`,
  );

  writeStepSummary(summaries, totals, value, passed);
}

function writeStepSummary(
  summaries: FileSummary[],
  totals: ReturnType<typeof computeTotals>,
  value: number,
  passed: boolean,
): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const worst = summaries.filter((s) => s.linePct < 100).slice(0, 15);
  const lines: string[] = [
    `## ${passed ? "✅" : "❌"} Coverage gate — ${metric} ≥ ${threshold}%`,
    "",
    "| Metric | Coverage | Covered / Total |",
    "| --- | --- | --- |",
    `| Lines | ${fmtPct(totals.linePct)} | ${totals.coveredLines} / ${totals.totalLines} |`,
  ];
  if (totals.totalFuncs > 0) {
    lines.push(
      `| Functions | ${fmtPct(totals.functionPct)} | ${totals.coveredFuncs} / ${totals.totalFuncs} |`,
    );
  }
  lines.push(
    "",
    `**Gate metric:** ${metric} = ${fmtPct(value)} (threshold ${threshold}%) — ${
      passed ? "passed" : "failed"
    }.`,
    `${summaries.length} source files measured; ${injectedFiles} had no unit test and count as 0%.`,
  );
  if (worst.length > 0) {
    lines.push("", "<details><summary>Lowest-covered files</summary>", "", "| Coverage | File |");
    lines.push("| --- | --- |");
    for (const s of worst) {
      lines.push(`| ${fmtPct(s.linePct)} (${s.coveredLines}/${s.totalLines}) | \`${s.file}\` |`);
    }
    lines.push("", "</details>");
  }
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

// --- discovery -----------------------------------------------------------

async function findSourceFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const rootDir = join(repoRoot, root);
    let packages: string[];
    try {
      packages = await readdir(rootDir);
    } catch {
      continue;
    }
    for (const pkg of packages) {
      await walkSource(join(rootDir, pkg, "src"), found);
    }
  }
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

async function findLcovFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const root of ["apps", "packages"]) {
    const rootDir = join(repoRoot, root);
    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const candidate = join(rootDir, name, "coverage", "lcov.info");
      if (await exists(candidate)) {
        found.push(candidate);
      }
    }
  }
  const rootLcov = join(repoRoot, "coverage", "lcov.info");
  if (await exists(rootLcov)) {
    found.push(rootLcov);
  }
  return found.sort();
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
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
