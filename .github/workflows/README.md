# CI — pull-request gate

`ci.yml` runs on every pull request (and on `merge_group` / pushes to `main`) and
must pass before a PR can merge. It enforces three things:

| Job            | Enforces                                  | Local equivalent          |
| -------------- | ----------------------------------------- | ------------------------- |
| `commit-lint`  | Conventional Commits on every commit + PR title | `bun run check:commits`   |
| `lint`         | `biome check .` is clean (lint + format)  | `bun run lint`            |
| `architecture` | Plugin/package import boundaries hold      | `bun run check:boundaries` |
| `coverage`     | Unit tests pass **and** repo line coverage ≥ 80% | `bun run test:coverage`   |

A final job, **`gate`**, simply waits on the four above and fails if any did not
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

## 3. Architecture boundaries

`bun run check:boundaries` runs [`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts),
which fails if a package imports across a forbidden boundary (e.g. the app core
reaching into a concrete registry/scanner plugin). It reads the workspace
manifests directly and needs no `bun install`.

## 4. Coverage (≥ 80%)

`bun run test:unit` already emits a per-package `coverage/lcov.info`.
[`scripts/coverage-gate.ts`](../../scripts/coverage-gate.ts) turns those into one
repo-wide **line** coverage number and fails if it's below the threshold. Two
details keep that number honest:

- **Merged by source file.** A file imported across packages (e.g.
  `packages/types/src/index.ts`) is counted once, with its line hits unioned — a
  line is covered if any package's tests hit it.
- **Untested files count as 0%.** Bun's lcov only lists files a test actually
  loaded, so the gate also enumerates every source file under `apps/*/src` and
  `packages/*/src` and counts any that never appear in coverage as fully
  uncovered. Without this, brand-new untested code would be invisible to the
  gate.

**Excluded** from the denominator: tests, generated code (`*.gen.ts`, `*.d.ts`),
migrations, `dist`/`node_modules`, and **`apps/web`** (the web UI is covered by
Playwright e2e, not unit tests). Add more exclusions via `COVERAGE_EXCLUDE`
(comma-separated regex fragments matched against the repo-relative path).

```bash
bun run test:coverage                       # run unit tests, then gate at 80%
COVERAGE_THRESHOLD=85 bun run scripts/coverage-gate.ts   # different floor
COVERAGE_EXCLUDE='^apps/scan-worker/,/legacy/' bun run scripts/coverage-gate.ts
bun run scripts/coverage-gate.ts --metric=functions      # functions instead (see note)
```

> The gated metric is **lines** — it's the one that counts untested files as 0%.
> `--metric=functions` is informational and reflects only files that tests loaded.

The threshold is set once via the `COVERAGE_THRESHOLD` env in `ci.yml` (default
`80`). Lower it to ratchet up over time, or raise it as coverage improves. The
gate prints the lowest-covered files (and how many untested files were counted as
0%) and writes a summary to the GitHub job summary.

## Branch protection

Make the gate mandatory: **Settings → Branches → Branch protection rules** for
`main` → enable **Require status checks to pass before merging** → add
**`PR gate`** (the `gate` job). Optionally enable **Require branches to be up to
date** and a merge queue (the workflow already listens for `merge_group`).

## Tuning

- **Bun version** and **coverage threshold** are the two `env:` values at the top
  of `ci.yml`.
- To add another gate (e.g. type-checking), add a job running `bun run typecheck`
  and list it in the `gate` job's `needs`.
