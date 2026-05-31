import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_API_PORT ?? 3399);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 3398);
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [["list"]],
  globalSetup: "./tests/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "bun run apps/api/src/server.ts",
      url: `${BASE_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        API_PORT: String(PORT),
        API_HOST: "127.0.0.1",
        REGISTRY_PUBLIC_URL: BASE_URL,
        DATABASE_URL: TEST_DATABASE_URL,
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        SCANNER_ENABLED: "true",
      },
    },
    {
      command: "bun run apps/scan-worker/src/worker.ts",
      url: `http://127.0.0.1:${WORKER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        WORKER_PORT: String(WORKER_PORT),
        SCANNER_ENABLED: "true",
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: "bun run --filter '@hootifactory/web' dev",
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_API_URL: BASE_URL,
        WEB_PORT: String(WEB_PORT),
      },
    },
  ],
});
