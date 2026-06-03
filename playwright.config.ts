import { availableParallelism } from "node:os";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_API_PORT ?? 3399);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 3398);
const OIDC_PORT = Number(process.env.E2E_OIDC_PORT ?? 4578);
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function e2eWorkers(): number {
  const override = process.env.E2E_WORKERS;
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== override) {
      throw new Error("E2E_WORKERS must be a positive integer");
    }
    return parsed;
  }

  const defaultCap = process.argv.some((arg) => arg.includes("-cli.spec.ts")) ? 8 : 4;
  return Math.min(defaultCap, Math.max(1, availableParallelism()));
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: e2eWorkers(),
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
        API_TRUSTED_ORIGINS: WEB_URL,
        DATABASE_URL: TEST_DATABASE_URL,
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        SCANNER_ENABLED: "true",
        SCANNER_CLI_RUNTIME: "disabled",
        AUTH_OIDC_ENABLED: "true",
        AUTH_OIDC_NAME: "E2E SSO",
        AUTH_OIDC_ISSUER: `http://127.0.0.1:${OIDC_PORT}`,
        AUTH_OIDC_CLIENT_ID: "hootifactory-e2e",
        AUTH_OIDC_CLIENT_SECRET: "e2e-secret",
        AUTH_OIDC_GROUP_MAPPINGS: JSON.stringify({
          "oidc-admins": [{ org: "oidc-e2e", role: "owner" }],
        }),
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
        SCANNER_CLI_RUNTIME: "disabled",
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
