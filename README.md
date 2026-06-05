# 🦉 Hootifactory

A self-hostable, **multi-format artifact & package manager** — an open-source alternative to JFrog Artifactory + Harbor + a standalone scanner, in one tool.

- **Formats:** npm, Docker, OCI, PyPI, Helm, Go, Cargo, NuGet, Scoop (9 total). npm,
  Docker, OCI, PyPI, Helm, Go, Cargo and NuGet are verified end-to-end against
  Dockerized real clients.
- **Repository kinds:** hosted, proxy (pull-through cache), virtual (group/aggregate).
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

## Observability

The API plus scan and mail workers emit correlated JSON logs by default. Each
HTTP request gets `x-request-id` and `x-correlation-id` response headers, and log
lines written inside that request or a derived queue job include `request_id`,
`correlation_id`, `trace_id` and `span_id`.

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` to export logs, traces
and metrics over OTLP/HTTP. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
override the base endpoint for individual signals. The API defaults to
`service.name=hootifactory-api`; the workers default to
`service.name=hootifactory-scan-worker` and
`service.name=hootifactory-mail-worker`. Set `OTEL_SERVICE_NAME` or
`OTEL_RESOURCE_ATTRIBUTES` to override resource metadata.

Traces include HTTP ingress, auth resolution, registry repository resolution,
RBAC decisions, adapter dispatch, proxy refreshes, virtual repository fan-out,
queue enqueue/worker registration, worker health checks, queue batch/job
processing, email delivery, and scan phases from artifact loading through finding
persistence and policy decision. Metrics cover HTTP, registry dispatch, and
worker queue job/batch counts, durations and active job gauges.

## Monorepo layout

```
apps/
  api/          registry HTTP server (Bun + Hono)
  scan-worker/  async scanning pipeline (pg-boss consumer)
  web/          management UI (React + Vite + Tailwind + shadcn)
packages/
  config/  types/  core/  db/  storage/  auth/  contracts/
  registry/              protocol-neutral registry plugin SDK (contracts + helpers)
  registry-application/  platform use cases split by slice: routing, runtime,
                         repositories, content, inventory, assets, governance, oci
  registry-runtime/      built-in registry manifest + config-driven loader
  registry-npm/  registry-oci/  registry-pypi/  registry-go/  registry-cargo/  registry-nuget/  registry-scoop/
  scanner/               scanner plugin SDK (ScannerPlugin contract + registry + runners)
  scanner-runtime/       built-in scanner manifest + config-driven loader
  scanner-grype/  scanner-trivy/  scanner-clamav/  scanner-osv/  scanner-heuristic/
  queue/  observability/  scan-core/  email/
```

Registry formats and scanners are independent plugin packages behind their own
SDKs (`@hootifactory/registry`, `@hootifactory/scanner`). The app core never names
a concrete format or scanner: each is registered through its `*-runtime` loader
from a static manifest, optionally narrowed by the `REGISTRY_PLUGINS` / `SCANNERS`
operator allowlists. Adding one is a new package plus a manifest line.

`bun run check:boundaries` validates the workspace manifests, route-layer import
boundaries, API v1 contract docs, and registry-application slice exports.

## Quick start (dev)

```bash
bun install
cp .env.example .env
docker compose up -d        # postgres + minio
bun run db:migrate
bun run db:seed             # creates a demo org + owner user; prints generated dev credentials
bun run dev                 # api on :3000
bun run dev:web             # web on :5173 (proxies /v2 + /api -> api)
bun run dev:mail            # queued email worker; Mailpit UI is on :8025
```

The compose file is a localhost-only development/demo stack. Its published ports
bind to `127.0.0.1` by default and it uses dev credentials; do not deploy
`docker compose --profile app up --build` to production or an internet-facing
host. Use a production manifest with `NODE_ENV=production` and real secrets.

For production bootstrap, set `SEED_USER` and `SEED_PASS` explicitly before `bun run db:seed`.
Production seed runs never print passwords or owner token secrets.

Keep database dumps outside the repository tree, or encrypt them before storing
them under ignored local paths; dumps can contain token, session, and password
hashes even when raw secrets are not present.

Start with this README and the package entry points above for architecture
orientation; the automated boundary check is the source of truth for enforced
module rules.
