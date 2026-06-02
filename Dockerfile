# Multi-stage build for the Hootifactory API + scan-worker (single image).
# The same image runs the API (default) or the scan-worker (CMD override).
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json biome.json drizzle.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN bun install --frozen-lockfile
# Build the web UI (served by the API via WEB_DIST).
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
COPY --from=build /app /app
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
