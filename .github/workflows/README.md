# CI — pull-request gate

`ci.yml` runs on every pull request (and on `merge_group` / pushes to `main`) and
must pass before a PR can merge. It enforces these checks:

| Job            | Enforces                                  | Local equivalent          |
| -------------- | ----------------------------------------- | ------------------------- |
| `commit-lint`  | Conventional Commits on every commit + PR title | `bun run check:commits`   |
| `lint`         | `biome check .` is clean (lint + format)  | `bun run lint`            |
| `typecheck`    | `tsc --noEmit` across every package        | `bun run typecheck`       |
| `architecture` | Plugin/package import boundaries hold      | `bun run check:boundaries` |
| `coverage`     | Unit tests pass **and** every package's line coverage ≥ 80% (per-package floor) | `bun run test:coverage`   |

A final job, **`gate`**, simply waits on the five above and fails if any did not
pass. Point branch protection at `gate` (see below) so you have a single, stable
required check.

## 1. Conventional commits

Every non-merge commit introduced by the PR — and the PR title, since it becomes
the commit subject on a squash merge — must match:

```
<type>[optional scope][!]: <subject>
```

- **types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`
- `!` marks a breaking change, e.g. `feat(api)!: drop legacy upload route`
- header ≤ 100 chars, non-empty subject, no trailing period

Merge, revert, and `fixup!`/`squash!` commits are ignored (matching commitlint's
defaults). The rule lives in [`scripts/check-commits.ts`](../../scripts/check-commits.ts).

Validate locally before pushing:

```bash
bun run check:commits                 # all commits since origin/main + nothing else
bun run scripts/check-commits.ts --message "feat(web): add dark mode"
```

Optional local `commit-msg` hook (rejects bad messages before they're committed):

```bash
# .git/hooks/commit-msg
#!/usr/bin/env bash
exec bun run scripts/check-commits.ts --message "$(cat "$1")"
```

## 2. Lint

`bun run lint` runs `biome check .`, which fails on both lint violations and
unformatted code. Auto-fix locally with `bun run format`.

## 3. Typecheck

`bun run typecheck` runs `tsc --noEmit` across every workspace package. This
catches cross-package API drift and generated type mismatches that lint does not
see.

## 4. Architecture Boundaries

`bun run check:boundaries` runs [`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts),
which fails if a package imports across a forbidden boundary (e.g. the app core
reaching into a concrete registry/scanner plugin). It reads the workspace
manifests directly and needs no `bun install`.

## 5. Per-package Coverage Floor

`bun run test:unit` runs each package's tests with `cwd` set to that package, so
every package emits its **own** `coverage/lcov.info`.
[`scripts/coverage-gate.ts`](../../scripts/coverage-gate.ts) measures **each
package independently** on its own `src/` **line** coverage and fails if **any**
package is below the floor — there is no repo-wide aggregate, so each package
must test itself. Two details keep each package's number honest:

- **Only the package's own `src/`.** When a package's tests load code from
  another package (e.g. `packages/types/src/index.ts`), Bun records it in that
  package's lcov; the gate discards those cross-package records so a package can't
  borrow coverage from code it merely imports.
- **Untested files count as 0%.** Bun's lcov only lists files a test actually
  loaded, so the gate also enumerates every source file under the package's
  `src/` and counts any that never appear in its coverage as fully uncovered.
  Without this, brand-new untested code would be invisible to the gate.

**Excluded** from every package's denominator: tests, generated code
(`*.gen.ts`, `*.d.ts`), migrations, `dist`/`node_modules`. Whole packages can be
excluded via the script's `EXCLUDED_PACKAGES` set — **`apps/web`** is excluded
(the web UI is covered by Playwright e2e, not unit tests). Add path-level
exclusions via `COVERAGE_EXCLUDE` (comma-separated regex fragments matched
against the repo-relative path). A package with no measurable runtime lines
(pure type/barrel package) passes automatically.

```bash
bun run test:coverage                       # run unit tests, then enforce the floor
COVERAGE_THRESHOLD=85 bun run scripts/coverage-gate.ts   # different floor
COVERAGE_EXCLUDE='/legacy/' bun run scripts/coverage-gate.ts
bun run scripts/coverage-gate.ts --metric=functions      # functions instead (see note)
```

> The gated metric is **lines** — it's the one that counts untested files as 0%.
> `--metric=functions` is informational and reflects only files that tests loaded.

### Floor

`COVERAGE_THRESHOLD` in `ci.yml` is the **per-package floor**, currently **`80`**.
Every package must meet it on its own `src/`; the gate fails listing any package
below it. Never lower it.

The `coverage` job runs only `test:unit`, which is **hermetic** — no database or
object storage. Tests that need Postgres/S3 are named `*.integration.test.ts` and
run via `bun run test:integration` (with the compose services up), not in this
gate. If you add a test that opens a DB/S3 connection, name it
`*.integration.test.ts` so the unit gate stays service-free.

The gate prints a per-package table (worst-first) with each package's coverage and
PASS/FAIL, lists the lowest-covered files for every failing package, and writes
the same summary to the GitHub job summary.

## Branch protection

Make the gate mandatory: **Settings → Branches → Branch protection rules** for
`main` → enable **Require status checks to pass before merging** → add
**`PR gate`** (the `gate` job). Optionally enable **Require branches to be up to
date** and a merge queue (the workflow already listens for `merge_group`).

## Tuning

- **Bun version** and **coverage threshold** are the two `env:` values at the top
  of `ci.yml`.
- To add another gate, add a job and list it in the `gate` job's `needs` (and its
  result check), the way `typecheck` and `architecture` are wired in.
