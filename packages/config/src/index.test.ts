import { describe, expect, test } from "bun:test";
import { loadEnv } from "./index";

const prodSourceBase = {
  NODE_ENV: "production",
  SESSION_SECRET: "prod-session-secret-with-enough-entropy",
  S3_ACCESS_KEY_ID: "prod-access-key",
  S3_SECRET_ACCESS_KEY: "prod-secret-key",
  REGISTRY_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----",
  REGISTRY_JWT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----",
};
const prodSource = {
  ...prodSourceBase,
  DATABASE_URL: "postgres://prod_user:prod_password@localhost:5432/hootifactory",
};

describe("environment auth creation defaults", () => {
  test("development and test allow self-service creation by default", () => {
    const devEnv = loadEnv({ NODE_ENV: "development" });
    expect(devEnv.AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(devEnv.AUTH_ALLOW_ORG_CREATION).toBe(true);
    expect(devEnv.API_TRUSTED_ORIGINS).toEqual([]);
    expect(devEnv.AUTH_LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(devEnv.AUTH_LOGIN_WINDOW_SECONDS).toBe(60);
    expect(devEnv.AUTH_THROTTLE_MAX_BUCKETS).toBe(10_000);
    expect(devEnv.AUTH_THROTTLE_SWEEP_INTERVAL_SECONDS).toBe(5 * 60);
    expect(devEnv.AUTH_REGISTRATION_MAX_ATTEMPTS).toBe(3);
    expect(devEnv.AUTH_REGISTRATION_WINDOW_SECONDS).toBe(5 * 60);
    expect(devEnv.AUTH_PASSWORD_RESET_TTL_SECONDS).toBe(30 * 60);
    expect(devEnv.AUTH_OIDC_LINK_TTL_SECONDS).toBe(15 * 60);
    expect(devEnv.EMAIL_ENABLED).toBe(false);
    expect(devEnv.DATABASE_POOL_MAX).toBe(20);
    expect(devEnv.DATABASE_POOL_IDLE_TIMEOUT_SECONDS).toBe(30);
    expect(devEnv.DATABASE_POOL_MAX_LIFETIME_SECONDS).toBe(30 * 60);
    expect(devEnv.DATABASE_POOL_CONNECTION_TIMEOUT_SECONDS).toBe(10);
    expect(devEnv.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(devEnv.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS).toBe(30_000);
    expect(devEnv.PG_BOSS_POOL_MAX).toBe(5);
    expect(devEnv.REGISTRY_MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(devEnv.REGISTRY_MAX_STAGED_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(devEnv.REGISTRY_MAX_INFLIGHT_UPLOAD_BYTES).toBe(256 * 1024 * 1024);
    expect(devEnv.REGISTRY_MAX_VIRTUAL_MEMBERS).toBe(32);
    expect(devEnv.REGISTRY_VIRTUAL_MEMBER_CONCURRENCY).toBe(8);
    expect(devEnv.REGISTRY_ALLOW_PRIVATE_UPSTREAMS).toBe(false);
    expect(devEnv.S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(devEnv.SCAN_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(devEnv.SCANNER_CLI_RUNTIME).toBe("docker");
    expect(devEnv.SCANNER_DOCKER_MEMORY).toBe("1g");
    expect(devEnv.SCANNER_DOCKER_CPUS).toBe("2");
    expect(devEnv.SCANNER_DOCKER_PIDS_LIMIT).toBe(512);
    expect(devEnv.REGISTRY_PLUGINS).toBeUndefined();
    expect(devEnv.SCANNERS).toBeUndefined();
    expect(loadEnv({ NODE_ENV: "test" }).AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(loadEnv({ NODE_ENV: "test" }).AUTH_ALLOW_ORG_CREATION).toBe(true);
  });

  test("production disables self-service creation by default", () => {
    const env = loadEnv(prodSource);
    expect(env.AUTH_ALLOW_REGISTRATION).toBe(false);
    expect(env.AUTH_ALLOW_ORG_CREATION).toBe(false);
  });

  test("production rejects default database credentials", () => {
    expect(() => loadEnv(prodSourceBase)).toThrow(
      /DATABASE_URL must not use the dev-default database username or password in production/,
    );
    expect(() =>
      loadEnv({
        ...prodSource,
        DATABASE_URL: "postgres://hootifactory:prod_password@db:5432/hootifactory",
      }),
    ).toThrow(/DATABASE_URL must not use the dev-default database username or password/);
    expect(() =>
      loadEnv({
        ...prodSource,
        DATABASE_URL: "postgres://prod_user:hootifactory@db:5432/hootifactory",
      }),
    ).toThrow(/DATABASE_URL must not use the dev-default database username or password/);
  });

  test("production rejects dev-default secrets from the template", async () => {
    const example = await Bun.file(new URL("../../../.env.example", import.meta.url)).text();
    const sessionSecret = /^SESSION_SECRET=(.+)$/m.exec(example)?.[1];
    expect(sessionSecret).toBeTruthy();

    expect(() => loadEnv({ ...prodSource, SESSION_SECRET: sessionSecret! })).toThrow(
      /SESSION_SECRET must be overridden in production/,
    );
    expect(() =>
      loadEnv({
        ...prodSource,
        SESSION_SECRET: "dev-session-secret-change-me-please-32+chars",
      }),
    ).toThrow(/SESSION_SECRET must be overridden in production/);
    expect(() => loadEnv({ ...prodSource, S3_ACCESS_KEY_ID: "hootifactory" })).toThrow(
      /S3_ACCESS_KEY_ID must be overridden in production/,
    );
    expect(() => loadEnv({ ...prodSource, S3_SECRET_ACCESS_KEY: "hootifactory" })).toThrow(
      /S3_SECRET_ACCESS_KEY must be overridden in production/,
    );
  });

  test("production can explicitly opt into self-service creation", () => {
    const env = loadEnv({
      ...prodSource,
      AUTH_ALLOW_REGISTRATION: "true",
      AUTH_ALLOW_ORG_CREATION: "true",
    });
    expect(env.AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(env.AUTH_ALLOW_ORG_CREATION).toBe(true);
  });

  test(".env.example does not force production-sensitive self-service flags on", async () => {
    const example = await Bun.file(new URL("../../../.env.example", import.meta.url)).text();
    expect(example).not.toMatch(/^AUTH_ALLOW_REGISTRATION\s*=\s*true\s*$/m);
    expect(example).not.toMatch(/^AUTH_ALLOW_ORG_CREATION\s*=\s*true\s*$/m);
  });

  test("generic scanner runtime knobs are validated and normalized", () => {
    const env = loadEnv({
      S3_PUBLIC_ENDPOINT: "https://cdn.example.test/s3/",
      SCANNER_CLI_RUNTIME: "host",
    });
    expect(env.S3_PUBLIC_ENDPOINT).toBe("https://cdn.example.test/s3");
    expect(env.SCANNER_CLI_RUNTIME).toBe("host");
    expect(() => loadEnv({ S3_PUBLIC_ENDPOINT: "notaurl" })).toThrow();
    expect(() => loadEnv({ SCANNER_CLI_RUNTIME: "local" })).toThrow();
    expect(() => loadEnv({ SCANNER_DOCKER_MEMORY: "large" })).toThrow();
    expect(() => loadEnv({ SCANNER_DOCKER_CPUS: "0" })).toThrow();
    expect(() => loadEnv({ SCANNER_DOCKER_PIDS_LIMIT: "0" })).toThrow();
    expect(() => loadEnv({ SCANNER_DOCKER_STORAGE_SIZE: "large" })).toThrow();
  });

  test("plugin allowlists parse to a deduped list or undefined when unset", () => {
    expect(loadEnv({}).SCANNERS).toBeUndefined();
    expect(loadEnv({ SCANNERS: "  " }).SCANNERS).toBeUndefined();
    expect(loadEnv({ SCANNERS: "grype, trivy ,grype,osv" }).SCANNERS).toEqual([
      "grype",
      "trivy",
      "osv",
    ]);
    expect(loadEnv({ REGISTRY_PLUGINS: "npm,oci" }).REGISTRY_PLUGINS).toEqual(["npm", "oci"]);
  });

  test("registry upload limit is a positive integer", () => {
    expect(loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "1048576" }).REGISTRY_MAX_UPLOAD_BYTES).toBe(
      1048576,
    );
    expect(
      loadEnv({ REGISTRY_MAX_STAGED_UPLOAD_BYTES: "2097152" }).REGISTRY_MAX_STAGED_UPLOAD_BYTES,
    ).toBe(2097152);
    expect(
      loadEnv({ REGISTRY_MAX_INFLIGHT_UPLOAD_BYTES: "3145728" }).REGISTRY_MAX_INFLIGHT_UPLOAD_BYTES,
    ).toBe(3145728);
    expect(() => loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "0" })).toThrow();
    expect(() => loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "-1" })).toThrow();
    expect(() => loadEnv({ REGISTRY_MAX_STAGED_UPLOAD_BYTES: "0" })).toThrow();
    expect(() => loadEnv({ REGISTRY_MAX_INFLIGHT_UPLOAD_BYTES: "0" })).toThrow();
    expect(() => loadEnv({ REGISTRY_MAX_VIRTUAL_MEMBERS: "0" })).toThrow();
    expect(() => loadEnv({ REGISTRY_VIRTUAL_MEMBER_CONCURRENCY: "0" })).toThrow();
  });

  // Per-scanner image digest-pin enforcement moved into each scanner plugin
  // (assertDigestPinnedImage at config-resolution time); see scanner-grype et al.

  test("database and queue pool configuration is positive integer based", () => {
    const env = loadEnv({
      DATABASE_POOL_MAX: "30",
      DATABASE_POOL_IDLE_TIMEOUT_SECONDS: "45",
      DATABASE_POOL_MAX_LIFETIME_SECONDS: "3600",
      DATABASE_POOL_CONNECTION_TIMEOUT_SECONDS: "15",
      DATABASE_STATEMENT_TIMEOUT_MS: "45000",
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "60000",
      PG_BOSS_POOL_MAX: "7",
    });
    expect(env.DATABASE_POOL_MAX).toBe(30);
    expect(env.DATABASE_POOL_IDLE_TIMEOUT_SECONDS).toBe(45);
    expect(env.DATABASE_POOL_MAX_LIFETIME_SECONDS).toBe(3600);
    expect(env.DATABASE_POOL_CONNECTION_TIMEOUT_SECONDS).toBe(15);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(45_000);
    expect(env.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS).toBe(60_000);
    expect(env.PG_BOSS_POOL_MAX).toBe(7);
    expect(() => loadEnv({ DATABASE_POOL_MAX: "0" })).toThrow();
    expect(() => loadEnv({ DATABASE_STATEMENT_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadEnv({ PG_BOSS_POOL_MAX: "0" })).toThrow();
  });

  test("private registry upstreams require explicit non-production opt-in", () => {
    expect(
      loadEnv({ REGISTRY_ALLOW_PRIVATE_UPSTREAMS: "true" }).REGISTRY_ALLOW_PRIVATE_UPSTREAMS,
    ).toBe(true);
    expect(() =>
      loadEnv({
        ...prodSource,
        REGISTRY_ALLOW_PRIVATE_UPSTREAMS: "true",
      }),
    ).toThrow(/REGISTRY_ALLOW_PRIVATE_UPSTREAMS cannot be enabled in production/);
  });

  test("trusted API origins are normalized and validated", () => {
    expect(
      loadEnv({
        API_TRUSTED_ORIGINS: "http://localhost:5173/, https://app.example/path",
      }).API_TRUSTED_ORIGINS,
    ).toEqual(["http://localhost:5173", "https://app.example"]);
    expect(() => loadEnv({ API_TRUSTED_ORIGINS: "notaurl" })).toThrow();
    expect(() => loadEnv({ API_TRUSTED_ORIGINS: "ftp://example.test" })).toThrow();
  });

  test("login throttle configuration is positive integer based", () => {
    const env = loadEnv({
      AUTH_LOGIN_MAX_ATTEMPTS: "7",
      AUTH_LOGIN_WINDOW_SECONDS: "120",
      AUTH_REGISTRATION_MAX_ATTEMPTS: "4",
      AUTH_REGISTRATION_WINDOW_SECONDS: "180",
    });
    expect(env.AUTH_LOGIN_MAX_ATTEMPTS).toBe(7);
    expect(env.AUTH_LOGIN_WINDOW_SECONDS).toBe(120);
    expect(env.AUTH_REGISTRATION_MAX_ATTEMPTS).toBe(4);
    expect(env.AUTH_REGISTRATION_WINDOW_SECONDS).toBe(180);
    expect(loadEnv({ AUTH_THROTTLE_MAX_BUCKETS: "100" }).AUTH_THROTTLE_MAX_BUCKETS).toBe(100);
    expect(
      loadEnv({ AUTH_THROTTLE_SWEEP_INTERVAL_SECONDS: "600" }).AUTH_THROTTLE_SWEEP_INTERVAL_SECONDS,
    ).toBe(600);
    expect(() => loadEnv({ AUTH_LOGIN_MAX_ATTEMPTS: "0" })).toThrow();
    expect(() => loadEnv({ AUTH_LOGIN_WINDOW_SECONDS: "-1" })).toThrow();
    expect(() => loadEnv({ AUTH_THROTTLE_MAX_BUCKETS: "0" })).toThrow();
    expect(() => loadEnv({ AUTH_THROTTLE_SWEEP_INTERVAL_SECONDS: "0" })).toThrow();
    expect(() => loadEnv({ AUTH_REGISTRATION_MAX_ATTEMPTS: "0" })).toThrow();
    expect(() => loadEnv({ AUTH_REGISTRATION_WINDOW_SECONDS: "-1" })).toThrow();
  });

  test("email configuration is validated when enabled", () => {
    const env = loadEnv({
      EMAIL_ENABLED: "true",
      EMAIL_SMTP_HOST: "mailpit",
      EMAIL_SMTP_PORT: "1025",
      EMAIL_SMTP_SECURE: "false",
      EMAIL_FROM: "Hootifactory <noreply@example.test>",
      APP_PUBLIC_URL: "https://hoot.example.test/",
    });
    expect(env.EMAIL_ENABLED).toBe(true);
    expect(env.EMAIL_SMTP_HOST).toBe("mailpit");
    expect(env.EMAIL_SMTP_PORT).toBe(1025);
    expect(env.EMAIL_SMTP_REQUIRE_TLS).toBe(false);
    expect(env.APP_PUBLIC_URL).toBe("https://hoot.example.test");
    expect(() => loadEnv({ EMAIL_ENABLED: "true" })).toThrow(/EMAIL_SMTP_HOST/);
    expect(() => loadEnv({ EMAIL_SMTP_PORT: "0" })).toThrow();
    expect(() => loadEnv({ APP_PUBLIC_URL: "notaurl" })).toThrow();
  });

  test("production requires TLS for credentialed SMTP transports", () => {
    const credentialedSmtp = {
      ...prodSource,
      EMAIL_ENABLED: "true",
      EMAIL_SMTP_HOST: "smtp.example.test",
      EMAIL_SMTP_PORT: "587",
      EMAIL_SMTP_USER: "mailer",
      EMAIL_SMTP_PASSWORD: "secret",
    };

    expect(loadEnv(credentialedSmtp).EMAIL_SMTP_REQUIRE_TLS).toBe(true);
    expect(
      loadEnv({
        ...credentialedSmtp,
        EMAIL_SMTP_REQUIRE_TLS: "true",
      }).EMAIL_SMTP_REQUIRE_TLS,
    ).toBe(true);
    expect(
      loadEnv({
        ...credentialedSmtp,
        EMAIL_SMTP_SECURE: "true",
        EMAIL_SMTP_REQUIRE_TLS: "false",
      }).EMAIL_SMTP_REQUIRE_TLS,
    ).toBe(false);
    expect(() =>
      loadEnv({
        ...credentialedSmtp,
        EMAIL_SMTP_REQUIRE_TLS: "false",
      }),
    ).toThrow(/EMAIL_SMTP_REQUIRE_TLS/);
  });

  test("OIDC configuration is parsed when enabled", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      AUTH_OIDC_ENABLED: "true",
      AUTH_OIDC_NAME: "Zitadel",
      AUTH_OIDC_ISSUER: "http://idp.test/",
      AUTH_OIDC_CLIENT_ID: "hootifactory",
      AUTH_OIDC_CLIENT_SECRET: "secret",
      AUTH_OIDC_SCOPES: "openid email profile groups email",
      AUTH_OIDC_GROUP_MAPPINGS: JSON.stringify({
        developers: [{ org: "acme", group: "developers" }],
        admins: [
          { org: "acme", group: "owners" },
          { org: "tools", group: "admins" },
        ],
      }),
      AUTH_SYSTEM_ADMIN_USER_IDS:
        "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
    });
    expect(env.AUTH_OIDC_ENABLED).toBe(true);
    expect(env.AUTH_OIDC_NAME).toBe("Zitadel");
    expect(env.AUTH_OIDC_ISSUER).toBe("http://idp.test");
    expect(env.AUTH_OIDC_SCOPES).toEqual(["openid", "email", "profile", "groups"]);
    expect(env.AUTH_OIDC_GROUP_MAPPINGS.admins?.[1]).toEqual({
      org: "tools",
      group: "admins",
    });
    expect(env.AUTH_SYSTEM_ADMIN_USER_IDS).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  test("system-admin bootstrap user ids must be UUIDs", () => {
    expect(() => loadEnv({ AUTH_SYSTEM_ADMIN_USER_IDS: "admin@example.test" })).toThrow(
      /invalid user id/,
    );
  });

  test("OIDC fails closed when enabled without required config", () => {
    expect(() => loadEnv({ AUTH_OIDC_ENABLED: "true" })).toThrow(/AUTH_OIDC_ISSUER is required/);
    expect(() =>
      loadEnv({
        AUTH_OIDC_ENABLED: "true",
        AUTH_OIDC_ISSUER: "https://idp.test",
        AUTH_OIDC_CLIENT_ID: "hootifactory",
        AUTH_OIDC_CLIENT_SECRET: "secret",
        AUTH_OIDC_GROUP_MAPPINGS: "{}",
      }),
    ).toThrow(/AUTH_OIDC_GROUP_MAPPINGS/);
  });

  test("production OIDC issuer must use https", () => {
    expect(() =>
      loadEnv({
        ...prodSource,
        AUTH_OIDC_ENABLED: "true",
        AUTH_OIDC_ISSUER: "http://idp.test",
        AUTH_OIDC_CLIENT_ID: "hootifactory",
        AUTH_OIDC_CLIENT_SECRET: "secret",
        AUTH_OIDC_GROUP_MAPPINGS: JSON.stringify({
          admins: [{ org: "acme", group: "owners" }],
        }),
      }),
    ).toThrow(/AUTH_OIDC_ISSUER must use https/);
  });
});
