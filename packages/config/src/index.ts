import { z } from "zod";

/**
 * Coerce common boolean string env values, case-insensitively. Unrecognized
 * values fail loudly (rather than silently defaulting to false) so a typo like
 * `SCANNER_ENABLED=ture` is a startup error, not a silent security no-op.
 */
const boolish = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === "boolean") return v;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on", "y"].includes(s)) return true;
  if (["false", "0", "no", "off", "n", ""].includes(s)) return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a boolean, got "${v}"` });
  return z.NEVER;
});

/** An absolute URL (any scheme). Trailing slashes are stripped for safe joins. */
const absoluteUrl = z
  .string()
  .url()
  .transform((s) => s.replace(/\/+$/, ""));

const httpUrl = absoluteUrl.refine((s) => /^https?:\/\//.test(s), "must be an http(s) URL");

const optionalHttpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  httpUrl.optional(),
);

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const originList = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const origins: string[] = [];
    for (const raw of value.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      try {
        const url = new URL(item);
        if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported scheme");
        origins.push(url.origin);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid trusted origin "${item}"`,
        });
        return z.NEVER;
      }
    }
    return [...new Set(origins)];
  });

/** Well-known dev-default secret values that must never reach production. */
const DEV_DEFAULT_SECRETS = {
  SESSION_SECRET: "dev-session-secret-change-me-please-32chars",
  S3_ACCESS_KEY_ID: "hootifactory",
  S3_SECRET_ACCESS_KEY: "hootifactory",
} as const;

/**
 * Environment schema. Dev defaults mirror docker-compose so the stack boots and
 * `bun test` runs without a hand-written .env. Production deployments should
 * override the secrets (SESSION_SECRET, registry JWT keys, S3 creds).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // OpenTelemetry (logs, traces, metrics)
    OTEL_SDK_DISABLED: boolish.default(false),
    OTEL_SERVICE_NAME: optionalNonEmptyString,
    OTEL_SERVICE_VERSION: z.string().min(1).default("0.0.0"),
    OTEL_RESOURCE_ATTRIBUTES: z.string().default(""),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalHttpUrl,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optionalHttpUrl,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: optionalHttpUrl,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: optionalHttpUrl,
    OTEL_EXPORTER_OTLP_HEADERS: z.string().default(""),
    OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

    // API server
    API_PORT: z.coerce.number().int().positive().default(3000),
    API_HOST: z.string().default("0.0.0.0"),
    REGISTRY_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(100 * 1024 * 1024),
    REGISTRY_PUBLIC_URL: absoluteUrl.default("http://localhost:3000"),
    API_TRUSTED_ORIGINS: originList,
    /** When set, the API serves the built web UI (single-container deploys). */
    WEB_DIST: z.string().optional(),

    // Postgres
    DATABASE_URL: z
      .string()
      .refine((s) => /^postgres(ql)?:\/\//.test(s), "must be a postgres:// connection URL")
      .default("postgres://hootifactory:hootifactory@localhost:5432/hootifactory"),

    // Object storage (S3-compatible)
    S3_ENDPOINT: absoluteUrl.default("http://localhost:9000"),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().default("hootifactory"),
    S3_ACCESS_KEY_ID: z.string().default("hootifactory"),
    S3_SECRET_ACCESS_KEY: z.string().default("hootifactory"),
    S3_FORCE_PATH_STYLE: boolish.default(true),

    // Auth
    SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-please-32chars"),
    AUTH_ALLOW_REGISTRATION: boolish.optional(),
    AUTH_ALLOW_ORG_CREATION: boolish.optional(),
    AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    AUTH_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    REGISTRY_JWT_PRIVATE_KEY: z.string().optional(),
    REGISTRY_JWT_PUBLIC_KEY: z.string().optional(),
    REGISTRY_JWT_TTL: z.coerce.number().int().positive().default(300),

    // Scanning (Phase 3)
    SCANNER_ENABLED: boolish.default(false),
    SCANNER_CLI_RUNTIME: z.enum(["auto", "docker", "host", "disabled"]).default("docker"),
    SCANNER_DOCKER_COMMAND: z.string().default("docker"),
    SYFT_IMAGE: z.string().default("anchore/syft:latest"),
    GRYPE_IMAGE: z.string().default("anchore/grype:latest"),
    TRIVY_IMAGE: z.string().default("aquasec/trivy:latest"),
    CLAMAV_IMAGE: z.string().default("clamav/clamav:latest"),
    CLAMAV_REST_URL: optionalHttpUrl,
    TRIVY_SERVER_URL: optionalHttpUrl,
    OSV_API_URL: absoluteUrl.default("https://api.osv.dev"),
    SCAN_SCRATCH_DIR: z.string().default("./scratch"),
    SCAN_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(100 * 1024 * 1024),
  })
  .superRefine((v, ctx) => {
    // Fail fast (never silently boot) when a production deployment still carries a
    // well-known dev-default secret.
    if (v.NODE_ENV === "production") {
      for (const [key, devValue] of Object.entries(DEV_DEFAULT_SECRETS)) {
        if (v[key as keyof typeof DEV_DEFAULT_SECRETS] === devValue) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} must be overridden in production (it still holds the dev default)`,
          });
        }
      }
    }
    // The registry JWT keypair must be set together (both or neither), and is
    // mandatory in production — otherwise each instance signs OCI Bearer tokens
    // with an ephemeral keypair that no peer (or restart) can verify.
    const hasPriv = !!v.REGISTRY_JWT_PRIVATE_KEY;
    const hasPub = !!v.REGISTRY_JWT_PUBLIC_KEY;
    if (hasPriv !== hasPub) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasPriv ? "REGISTRY_JWT_PUBLIC_KEY" : "REGISTRY_JWT_PRIVATE_KEY"],
        message: "REGISTRY_JWT_PRIVATE_KEY and REGISTRY_JWT_PUBLIC_KEY must be set together",
      });
    }
    if (v.NODE_ENV === "production" && (!hasPriv || !hasPub)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REGISTRY_JWT_PRIVATE_KEY"],
        message:
          "REGISTRY_JWT_PRIVATE_KEY and REGISTRY_JWT_PUBLIC_KEY are required when NODE_ENV=production",
      });
    }
  })
  .transform((v) =>
    Object.freeze({
      ...v,
      AUTH_ALLOW_REGISTRATION: v.AUTH_ALLOW_REGISTRATION ?? v.NODE_ENV !== "production",
      AUTH_ALLOW_ORG_CREATION: v.AUTH_ALLOW_ORG_CREATION ?? v.NODE_ENV !== "production",
    }),
  );

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
