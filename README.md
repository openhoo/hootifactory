# 🦉 Hootifactory

A self-hostable, **multi-format artifact & package manager** — an open-source alternative to JFrog Artifactory + Harbor + a standalone scanner, in one tool.

- **Formats:** Docker/OCI, npm, PyPI (Phase 1); Helm, NuGet, Go, Cargo (later).
- **Repository kinds:** hosted, remote (pull-through proxy/cache), virtual (group/aggregate).
- **Supply-chain security:** SBOM generation, vulnerability + dependency + malware scanning, policy gates (audit / enforce).
- **Multi-tenant:** organizations, RBAC, scoped API tokens, audit log.

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
