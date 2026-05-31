import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_API_PORT ?? 3399);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

export default defineConfig({
  testDir: "./tests/e2e",
  // Tests share one Postgres + MinIO; run serially for deterministic state.
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
  webServer: {
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
    },
  },
});
