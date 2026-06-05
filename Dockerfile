# Multi-stage build for the Hootifactory API + scan-worker (single image).
# The same image runs the API (default) or the scan-worker (CMD override).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json biome.json drizzle.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN bun install --frozen-lockfile
# Build the web UI (served by the API via WEB_DIST).
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/mail-worker ./apps/mail-worker
COPY apps/scan-worker ./apps/scan-worker
COPY apps/web/package.json ./apps/web/package.json
COPY scripts/seed.ts ./scripts/seed.ts
RUN bun install --production --frozen-lockfile \
  --filter @hootifactory/api \
  --filter @hootifactory/mail-worker \
  --filter @hootifactory/scan-worker
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN find apps packages node_modules -type f \( -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.test.tsx' -o -name '*.spec.tsx' \) -delete
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    WEB_DIST=/app/apps/web/dist
EXPOSE 3000
USER bun
# Healthcheck hits the API readiness endpoint (/readyz verifies DB connectivity).
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "apps/api/src/server.ts"]
