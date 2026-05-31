import { z } from "zod";

/** Coerce common truthy string env values into booleans. */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "1" || v === "yes");

/**
 * Environment schema. Dev defaults mirror docker-compose so the stack boots and
 * `bun test` runs without a hand-written .env. Production deployments should
 * override the secrets (SESSION_SECRET, registry JWT keys, S3 creds).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // API server
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default("0.0.0.0"),
  REGISTRY_PUBLIC_URL: z.string().default("http://localhost:3000"),
  /** When set, the API serves the built web UI (single-container deploys). */
  WEB_DIST: z.string().optional(),

  // Postgres
  DATABASE_URL: z
    .string()
    .default("postgres://hootifactory:hootifactory@localhost:5432/hootifactory"),

  // Object storage (S3-compatible)
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("hootifactory"),
  S3_ACCESS_KEY_ID: z.string().default("hootifactory"),
  S3_SECRET_ACCESS_KEY: z.string().default("hootifactory"),
  S3_FORCE_PATH_STYLE: boolish.default(true),

  // Auth
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-please-32chars"),
  REGISTRY_JWT_PRIVATE_KEY: z.string().optional(),
  REGISTRY_JWT_PUBLIC_KEY: z.string().optional(),
  REGISTRY_JWT_TTL: z.coerce.number().int().positive().default(300),

  // Scanning (Phase 3)
  SCANNER_ENABLED: boolish.default(false),
  CLAMAV_REST_URL: z.string().optional(),
  TRIVY_SERVER_URL: z.string().optional(),
  OSV_API_URL: z.string().default("https://api.osv.dev"),
  SCAN_SCRATCH_DIR: z.string().default("./scratch"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

/** The validated, frozen runtime environment. */
export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** Re-parse a custom source (used in tests). */
export { loadEnv };
