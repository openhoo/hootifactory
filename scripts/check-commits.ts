/**
 * Conventional Commits gate.
 *
 * Validates that commit headers follow the Conventional Commits spec
 * (https://www.conventionalcommits.org), e.g. `feat(registry-rpm): add YUM/DNF`.
 * It checks two things, so the rule holds however a PR is merged:
 *   1. every non-merge commit introduced by the PR, and
 *   2. the PR title — which becomes the commit subject on a squash merge.
 *
 * Inputs (all optional; sensible local fallbacks):
 *   BASE_SHA / HEAD_SHA   commit range to validate (set by CI from the PR)
 *   PR_TITLE              PR title to validate (passed via env, never via shell)
 *   --from <ref> --to <ref>   explicit range override
 *   --message "<text>"   validate a single header and exit
 *   --no-commits | --no-title   skip one of the two checks
 *
 * With no range available it falls back to origin/<default>..HEAD, then to the
 * single HEAD commit. Merge, revert and autosquash commits are ignored to match
 * commitlint's default behaviour.
 *
 *   bun run scripts/check-commits.ts
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const ALLOWED_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
const HEADER_MAX_LENGTH = 100;
const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

// Commits that aren't authored by a human and shouldn't be linted — mirrors
// commitlint's defaultIgnores so generated merge/revert/fixup subjects pass.
const IGNORE_PATTERNS: RegExp[] = [
  /^Merge branch /,
  /^Merge pull request /,
  /^Merge remote-tracking branch /,
  /^Merge tag /,
  /^Merge .+ into /,
  /^Automatic merge/,
  /^Auto-merged .+ into /,
  /^(R|r)evert /,
  /^(amend|fixup|squash)!/,
];

const repoRoot = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);

interface Failure {
  source: string;
  header: string;
  reasons: string[];
}

const failures: Failure[] = [];
let checked = 0;

const singleMessage = getArgValue("--message");
if (singleMessage !== undefined) {
  if (collect("--message", singleMessage, failures)) {
    checked += 1;
  }
} else {
  if (!args.includes("--no-commits")) {
    checked += checkCommitRange();
  }
  if (!args.includes("--no-title")) {
    checked += checkPrTitle();
  }
}

report();
process.exit(failures.length > 0 ? 1 : 0);

// --- checks --------------------------------------------------------------

function checkCommitRange(): number {
  const range = resolveRange();
  if (!range) {
    console.log("• No commit range resolved; skipping per-commit validation.");
    return 0;
  }

  // tryGit (not git) so an unresolvable range — e.g. a base SHA missing from a
  // shallow/force-pushed checkout — reports cleanly instead of throwing.
  const revList = tryGit(["rev-list", "--no-merges", "--reverse", range]);
  if (revList === null) {
    console.warn(`• Could not resolve commit range ${range}; skipping per-commit validation.`);
    return 0;
  }

  const shas = revList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (shas.length === 0) {
    console.log(`• No non-merge commits in ${range}.`);
    return 0;
  }

  console.log(`• Validating ${shas.length} commit(s) in ${range}`);
  let count = 0;
  for (const sha of shas) {
    const message = git(["log", "-1", "--format=%B", sha]);
    if (collect(`${sha.slice(0, 8)}`, firstLine(message), failures)) {
      count += 1;
    }
  }
  return count;
}

function checkPrTitle(): number {
  const title = process.env.PR_TITLE?.trim();
  if (!title) {
    return 0;
  }
  console.log("• Validating PR title (squash-merge subject)");
  return collect("PR title", title, failures) ? 1 : 0;
}

// Validates one header unless it's an auto-generated message we ignore (merge,
// revert, fixup/squash). Returns whether the header was actually validated, so
// every entry point — commit range, PR title, and the --message hook — treats
// ignored messages identically. Failures are appended to `sink`.
function collect(source: string, header: string, sink: Failure[]): boolean {
  if (isIgnored(header)) {
    return false;
  }
  const reasons = validateHeader(header);
  if (reasons.length > 0) {
    sink.push({ source, header, reasons });
  }
  return true;
}

function validateHeader(rawHeader: string): string[] {
  const header = rawHeader.trim();
  const reasons: string[] = [];

  if (header.length === 0) {
    return ["header is empty"];
  }
  if (header.length > HEADER_MAX_LENGTH) {
    reasons.push(`header is ${header.length} chars (max ${HEADER_MAX_LENGTH})`);
  }

  const match = HEADER_RE.exec(header);
  if (!match?.groups) {
    reasons.push(
      'does not match "<type>[optional scope][!]: <subject>" ' +
        '(e.g. "feat(registry): add npm support")',
    );
    return reasons;
  }

  const type = match.groups.type ?? "";
  const subject = match.groups.subject ?? "";
  if (!ALLOWED_TYPES.includes(type)) {
    reasons.push(`type "${type}" is not one of: ${ALLOWED_TYPES.join(", ")}`);
  }
  if (subject.trim().length === 0) {
    reasons.push("subject is empty");
  }
  if (subject.trimEnd().endsWith(".")) {
    reasons.push("subject must not end with a period");
  }

  return reasons;
}

// --- range resolution ----------------------------------------------------

function resolveRange(): string | null {
  const from = getArgValue("--from") ?? process.env.BASE_SHA?.trim();
  // `|| "HEAD"` (not `??`) so an explicitly-empty HEAD_SHA falls back to HEAD
  // rather than producing an empty ref.
  const to = (getArgValue("--to") ?? process.env.HEAD_SHA?.trim() ?? "").trim() || "HEAD";

  if (from) {
    return `${from}..${to}`;
  }

  // Local fallback: diff against the default branch if we can find it.
  const base = defaultBranchRef();
  if (base) {
    const mergeBase = tryGit(["merge-base", base, to])?.trim();
    const headSha = tryGit(["rev-parse", to])?.trim();
    // Skip when the merge-base is HEAD itself (e.g. sitting on the default
    // branch): that's an empty range. Fall through to the single tip commit.
    if (mergeBase && mergeBase !== headSha) {
      return `${mergeBase}..${to}`;
    }
  }

  // Last resort: validate just the tip commit. A root commit has no parent, so
  // `${head}~1` is unresolvable — validate the commit itself (bare ref) instead.
  const head = tryGit(["rev-parse", to])?.trim();
  if (!head) {
    return null;
  }
  const hasParent = tryGit(["rev-parse", "--verify", "--quiet", `${head}^`]) !== null;
  return hasParent ? `${head}~1..${head}` : head;
}

function defaultBranchRef(): string | null {
  const envBase = process.env.GITHUB_BASE_REF?.trim();
  // Only remote-tracking refs: a bare local `main` while checked out on `main`
  // produces an empty range. Without a remote we fall through to the tip commit.
  const candidates = [envBase ? `origin/${envBase}` : null, "origin/main", "origin/master"].filter(
    (value): value is string => Boolean(value),
  );

  for (const ref of candidates) {
    if (tryGit(["rev-parse", "--verify", "--quiet", ref]) !== null) {
      return ref;
    }
  }
  return null;
}

// --- reporting -----------------------------------------------------------

function report(): void {
  if (failures.length === 0) {
    console.log(`\n✔ Conventional Commits: ${checked} header(s) checked, all valid.`);
    writeStepSummary(true);
    return;
  }

  console.error(`\n✖ Conventional Commits: ${failures.length} of ${checked} header(s) invalid.\n`);
  for (const failure of failures) {
    console.error(`  ${failure.source}: ${failure.header}`);
    for (const reason of failure.reasons) {
      console.error(`    └─ ${reason}`);
    }
  }
  console.error(
    `\nExpected: <type>[optional scope][!]: <subject>\nTypes:    ${ALLOWED_TYPES.join(", ")}`,
  );
  writeStepSummary(false);
}

function writeStepSummary(passed: boolean): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const lines: string[] = [
    `## ${passed ? "✅" : "❌"} Conventional Commits`,
    "",
    passed
      ? `All ${checked} commit/title header(s) follow Conventional Commits.`
      : `${failures.length} of ${checked} header(s) are invalid:`,
  ];
  if (!passed) {
    lines.push("", "| Source | Header | Problem |", "| --- | --- | --- |");
    for (const failure of failures) {
      const header = failure.header.replace(/\|/g, "\\|");
      lines.push(`| \`${failure.source}\` | ${header} | ${failure.reasons.join("; ")} |`);
    }
    lines.push(
      "",
      `Expected \`<type>[optional scope][!]: <subject>\` — types: ${ALLOWED_TYPES.join(", ")}.`,
    );
  }
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

// --- helpers -------------------------------------------------------------

function isIgnored(header: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(header));
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

function getArgValue(name: string): string | undefined {
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

function git(gitArgs: string[]): string {
  const result = Bun.spawnSync(["git", ...gitArgs], { cwd: repoRoot });
  if (!result.success) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`git ${gitArgs.join(" ")} failed: ${stderr || `exit ${result.exitCode}`}`);
  }
  return result.stdout.toString();
}

function tryGit(gitArgs: string[]): string | null {
  const result = Bun.spawnSync(["git", ...gitArgs], { cwd: repoRoot });
  return result.success ? result.stdout.toString() : null;
}
