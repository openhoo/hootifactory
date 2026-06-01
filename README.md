# 🦉 Hootifactory

A self-hostable, **multi-format artifact & package manager** — an open-source alternative to JFrog Artifactory + Harbor + a standalone scanner, in one tool.

- **Formats:** npm, Docker, OCI, PyPI, Helm, Go, Cargo, NuGet (8 total). npm,
  Docker, OCI, PyPI, Helm, Go, Cargo and NuGet are verified end-to-end against
  Dockerized real clients.
- **Repository kinds:** hosted, remote (pull-through proxy/cache), virtual (group/aggregate).
- **Supply-chain security:** dependency/malware scanning (heuristic + optional
  Syft/Grype/Trivy/OSV/ClamAV), policy gates (audit / enforce) that quarantine or
  block on findings, async scan workers (pg-boss).
- **Multi-tenant:** organizations, RBAC (`can()` with org-boundary enforcement),
  scoped API tokens, OIDC group→role mapping, audit log.
- **Governance:** storage quotas, retention pruning.

## Verification

```bash
bun run test             # unit tests across every workspace package/app
bun run test:integration # service-backed Bun tests, e.g. DB/MinIO integration
bun run test:all         # unit + integration
bun run e2e:install      # one-time: Playwright chromium
bun run test:e2e         # Playwright e2e — drives Dockerized npm/docker/oras/pip/helm/go/cargo/dotnet clients,
                         # the browser UI, proxy/virtual repos, scanning+policy gates, governance
bun run test:e2e:clients # real-client specs only; Docker supplies the external package-manager CLIs
```

Docker is the integration boundary for external CLIs. The e2e real-client specs
run npm, Docker, ORAS, pip/twine, Helm, Go, Cargo and dotnet through pinned
container images, and the optional scanner CLIs default to Docker images for
Syft, Grype, Trivy and ClamAV (`SCANNER_CLI_RUNTIME=docker`).

Unit tests are regular Bun `*.test.{ts,tsx}` or `*.spec.{ts,tsx}` files. Name
service-backed tests `*.integration.test.{ts,tsx}` so the default unit pass stays
fast and independent. Unit test runs emit Bun coverage tables and package-local
LCOV reports under `coverage/lcov.info`.

## Stack

Bun · Hono · Drizzle ORM + PostgreSQL · S3 / MinIO (content-addressable storage) · pg-boss · React + Vite + Tailwind + shadcn/ui.

## Monorepo layout

```
apps/
  api/          registry HTTP server (Bun + Hono)
  scan-worker/  async scanning pipeline (pg-boss consumer)
  web/          management UI (React + Vite + Tailwind + shadcn)
packages/
  config/  types/  db/  storage/  core/  auth/  queue/  scan-core/
  format-npm/  format-docker/  format-pypi/  ...
```

## Quick start (dev)

```bash
bun install
cp .env.example .env
docker compose up -d        # postgres + minio
bun run db:migrate
bun run db:seed             # creates a demo org + admin user + token
bun run dev                 # api on :3000
bun run dev:web             # web on :5173 (proxies /v2 + /api -> api)
```

See `docs/` and the architecture plan for details.
