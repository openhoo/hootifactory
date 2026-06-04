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

const dockerSize = z
  .string()
  .trim()
  .regex(/^\d+(?:[kmgKMG])?$/, "must be a Docker size value such as 512m or 1g");

const optionalDockerSize = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  dockerSize.optional(),
);

const dockerCpus = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/, "must be a positive CPU count such as 1 or 1.5")
  .refine((value) => Number(value) > 0, "must be greater than zero");

/** A coerced, positive integer env value with a default. */
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

/** A trimmed, non-empty string env value with a default. */
const trimmedString = (def: string) => z.string().trim().min(1).default(def);

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

const roleName = z.enum(["viewer", "developer", "admin", "owner"]);

const orgSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "org must be a slug (2-63 lowercase chars)");

const oidcScopes = z
  .string()
  .default("openid profile email groups")
  .transform((value) => [
    ...new Set(
      value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ])
  .refine((scopes) => scopes.includes("openid"), "AUTH_OIDC_SCOPES must include openid");

const OidcGroupMappingsSchema = z.record(
  z.string().min(1),
  z.array(z.strictObject({ org: orgSlug, role: roleName })).min(1),
);

const oidcGroupMappings = z
  .string()
  .default("{}")
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = value.trim() ? JSON.parse(value) : {};
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AUTH_OIDC_GROUP_MAPPINGS must be valid JSON",
      });
      return z.NEVER;
    }
    const result = OidcGroupMappingsSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["AUTH_OIDC_GROUP_MAPPINGS", ...issue.path],
        });
      }
      return z.NEVER;
    }
    return result.data;
  });

/** Well-known dev-default secret values that must never reach production. */
const DEV_DEFAULT_SECRETS = {
  SESSION_SECRET: "dev-session-secret-change-me-please-32chars",
  S3_ACCESS_KEY_ID: "hootifactory",
  S3_SECRET_ACCESS_KEY: "hootifactory",
} as const;
const DEV_DEFAULT_DATABASE_CREDENTIAL = "hootifactory";
const DEV_DEFAULT_SESSION_SECRET_PREFIX = "dev-session-secret-change-me";

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
    OTEL_METRIC_EXPORT_INTERVAL_MS: positiveInt(60_000),

    // API server
    API_PORT: positiveInt(3000),
    API_HOST: z.string().default("0.0.0.0"),
    APP_PUBLIC_URL: absoluteUrl.default("http://localhost:3000"),
    REGISTRY_MAX_UPLOAD_BYTES: positiveInt(100 * 1024 * 1024),
    REGISTRY_MAX_STAGED_UPLOAD_BYTES: positiveInt(100 * 1024 * 1024),
    REGISTRY_MAX_INFLIGHT_UPLOAD_BYTES: positiveInt(256 * 1024 * 1024),
    REGISTRY_PUBLIC_URL: absoluteUrl.default("http://localhost:3000"),
    REGISTRY_ALLOW_PRIVATE_UPSTREAMS: boolish.default(false),
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
    S3_PUBLIC_ENDPOINT: optionalHttpUrl,
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().default("hootifactory"),
    S3_ACCESS_KEY_ID: z.string().default("hootifactory"),
    S3_SECRET_ACCESS_KEY: z.string().default("hootifactory"),
    S3_FORCE_PATH_STYLE: boolish.default(true),

    // Auth
    SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-please-32chars"),
    AUTH_ALLOW_REGISTRATION: boolish.optional(),
    AUTH_ALLOW_ORG_CREATION: boolish.optional(),
    AUTH_LOGIN_MAX_ATTEMPTS: positiveInt(5),
    AUTH_LOGIN_WINDOW_SECONDS: positiveInt(60),
    AUTH_THROTTLE_MAX_BUCKETS: positiveInt(10_000),
    AUTH_THROTTLE_SWEEP_INTERVAL_SECONDS: positiveInt(5 * 60),
    AUTH_REGISTRATION_MAX_ATTEMPTS: positiveInt(3),
    AUTH_REGISTRATION_WINDOW_SECONDS: positiveInt(5 * 60),
    AUTH_PASSWORD_RESET_TTL_SECONDS: positiveInt(30 * 60),
    AUTH_PASSWORD_RESET_MAX_ATTEMPTS: positiveInt(3),
    AUTH_PASSWORD_RESET_WINDOW_SECONDS: positiveInt(5 * 60),
    AUTH_OIDC_LINK_TTL_SECONDS: positiveInt(15 * 60),
    AUTH_OIDC_ENABLED: boolish.default(false),
    AUTH_OIDC_NAME: z.string().trim().min(1).max(128).default("Single Sign-On"),
    AUTH_OIDC_ISSUER: optionalHttpUrl,
    AUTH_OIDC_CLIENT_ID: optionalNonEmptyString,
    AUTH_OIDC_CLIENT_SECRET: optionalNonEmptyString,
    AUTH_OIDC_SCOPES: oidcScopes,
    AUTH_OIDC_GROUP_CLAIM: trimmedString("groups"),
    AUTH_OIDC_EMAIL_CLAIM: trimmedString("email"),
    AUTH_OIDC_USERNAME_CLAIM: trimmedString("preferred_username"),
    AUTH_OIDC_GROUP_MAPPINGS: oidcGroupMappings,
    REGISTRY_JWT_PRIVATE_KEY: z.string().optional(),
    REGISTRY_JWT_PUBLIC_KEY: z.string().optional(),
    REGISTRY_JWT_TTL: positiveInt(300),

    // Email
    EMAIL_ENABLED: boolish.default(false),
    EMAIL_FROM: trimmedString("Hootifactory <noreply@localhost>"),
    EMAIL_SMTP_HOST: optionalNonEmptyString,
    EMAIL_SMTP_PORT: positiveInt(1025),
    EMAIL_SMTP_SECURE: boolish.default(false),
    EMAIL_SMTP_REQUIRE_TLS: boolish.optional(),
    EMAIL_SMTP_USER: optionalNonEmptyString,
    EMAIL_SMTP_PASSWORD: optionalNonEmptyString,

    // Scanning (Phase 3)
    SCANNER_ENABLED: boolish.default(false),
    SCANNER_OSV: boolish.default(false),
    SCANNER_TIMEOUT_MS: positiveInt(120_000),
    SCANNER_CLI_RUNTIME: z.enum(["auto", "docker", "host", "disabled"]).default("docker"),
    SCANNER_DOCKER_COMMAND: z.string().default("docker"),
    SCANNER_DOCKER_MEMORY: dockerSize.default("1g"),
    SCANNER_DOCKER_CPUS: dockerCpus.default("2"),
    SCANNER_DOCKER_PIDS_LIMIT: positiveInt(512),
    SCANNER_DOCKER_STORAGE_SIZE: optionalDockerSize,
    SYFT_IMAGE: z.string().default("anchore/syft:latest"),
    GRYPE_IMAGE: z.string().default("anchore/grype:latest"),
    TRIVY_IMAGE: z.string().default("aquasec/trivy:latest"),
    CLAMAV_IMAGE: z.string().default("clamav/clamav:latest"),
    CLAMAV_REST_URL: optionalHttpUrl,
    TRIVY_SERVER_URL: optionalHttpUrl,
    OSV_API_URL: absoluteUrl.default("https://api.osv.dev"),
    SCAN_SCRATCH_DIR: z.string().default("./scratch"),
    SCAN_MAX_BYTES: positiveInt(100 * 1024 * 1024),
  })
  .superRefine((v, ctx) => {
    // Fail fast (never silently boot) when a production deployment still carries a
    // well-known dev-default secret.
    if (v.NODE_ENV === "production") {
      for (const key of Object.keys(DEV_DEFAULT_SECRETS) as (keyof typeof DEV_DEFAULT_SECRETS)[]) {
        if (isDevDefaultSecret(key, v[key])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} must be overridden in production (it still holds the dev default)`,
          });
        }
      }
      if (databaseUrlUsesDevDefaultCredentials(v.DATABASE_URL)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATABASE_URL"],
          message:
            "DATABASE_URL must not use the dev-default database username or password in production",
        });
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
    if (v.NODE_ENV === "production" && v.REGISTRY_ALLOW_PRIVATE_UPSTREAMS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REGISTRY_ALLOW_PRIVATE_UPSTREAMS"],
        message: "REGISTRY_ALLOW_PRIVATE_UPSTREAMS cannot be enabled in production",
      });
    }
    if (v.AUTH_OIDC_ENABLED) {
      for (const key of [
        "AUTH_OIDC_ISSUER",
        "AUTH_OIDC_CLIENT_ID",
        "AUTH_OIDC_CLIENT_SECRET",
      ] as const) {
        if (!v[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when AUTH_OIDC_ENABLED=true`,
          });
        }
      }
      if (Object.keys(v.AUTH_OIDC_GROUP_MAPPINGS).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_OIDC_GROUP_MAPPINGS"],
          message: "AUTH_OIDC_GROUP_MAPPINGS must map at least one group when OIDC is enabled",
        });
      }
      if (v.NODE_ENV === "production" && v.AUTH_OIDC_ISSUER?.startsWith("http://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_OIDC_ISSUER"],
          message: "AUTH_OIDC_ISSUER must use https in production",
        });
      }
    }
    if (v.EMAIL_ENABLED && !v.EMAIL_SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EMAIL_SMTP_HOST"],
        message: "EMAIL_SMTP_HOST is required when EMAIL_ENABLED=true",
      });
    }
    if (
      v.NODE_ENV === "production" &&
      v.EMAIL_ENABLED &&
      (v.EMAIL_SMTP_USER || v.EMAIL_SMTP_PASSWORD) &&
      !v.EMAIL_SMTP_SECURE &&
      v.EMAIL_SMTP_REQUIRE_TLS === false
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EMAIL_SMTP_REQUIRE_TLS"],
        message: "EMAIL_SMTP_REQUIRE_TLS cannot be false with SMTP auth in production",
      });
    }
  })
  .transform((v) =>
    Object.freeze({
      ...v,
      AUTH_ALLOW_REGISTRATION: v.AUTH_ALLOW_REGISTRATION ?? v.NODE_ENV !== "production",
      AUTH_ALLOW_ORG_CREATION: v.AUTH_ALLOW_ORG_CREATION ?? v.NODE_ENV !== "production",
      EMAIL_SMTP_REQUIRE_TLS:
        v.EMAIL_SMTP_REQUIRE_TLS ??
        Boolean((v.EMAIL_SMTP_USER || v.EMAIL_SMTP_PASSWORD) && !v.EMAIL_SMTP_SECURE),
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

function databaseUrlUsesDevDefaultCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    if (!/^postgres(ql)?:$/.test(url.protocol)) return false;
    return (
      decodeURIComponent(url.username) === DEV_DEFAULT_DATABASE_CREDENTIAL ||
      decodeURIComponent(url.password) === DEV_DEFAULT_DATABASE_CREDENTIAL
    );
  } catch {
    return false;
  }
}

function isDevDefaultSecret(key: keyof typeof DEV_DEFAULT_SECRETS, value: string): boolean {
  if (key === "SESSION_SECRET") return value.startsWith(DEV_DEFAULT_SESSION_SECRET_PREFIX);
  return value === DEV_DEFAULT_SECRETS[key];
}

/** The validated, frozen runtime environment. */
export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** Re-parse a custom source (used in tests). */
export { loadEnv };
