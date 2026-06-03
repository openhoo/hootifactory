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
    expect(devEnv.AUTH_PASSWORD_RESET_TTL_SECONDS).toBe(30 * 60);
    expect(devEnv.AUTH_OIDC_LINK_TTL_SECONDS).toBe(15 * 60);
    expect(devEnv.EMAIL_ENABLED).toBe(false);
    expect(devEnv.REGISTRY_MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(devEnv.REGISTRY_ALLOW_PRIVATE_UPSTREAMS).toBe(false);
    expect(devEnv.SCAN_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(devEnv.SCANNER_CLI_RUNTIME).toBe("docker");
    expect(devEnv.GRYPE_IMAGE).toBe("anchore/grype:latest");
    expect(devEnv.TRIVY_IMAGE).toBe("aquasec/trivy:latest");
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

  test("production can explicitly opt into self-service creation", () => {
    const env = loadEnv({
      ...prodSource,
      AUTH_ALLOW_REGISTRATION: "true",
      AUTH_ALLOW_ORG_CREATION: "true",
    });
    expect(env.AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(env.AUTH_ALLOW_ORG_CREATION).toBe(true);
  });

  test("scanner endpoint URLs are validated and normalized", () => {
    const env = loadEnv({
      CLAMAV_REST_URL: "http://clamav:3310/scan/",
      TRIVY_SERVER_URL: "http://trivy:4954/",
      SCANNER_CLI_RUNTIME: "host",
    });
    expect(env.CLAMAV_REST_URL).toBe("http://clamav:3310/scan");
    expect(env.TRIVY_SERVER_URL).toBe("http://trivy:4954");
    expect(env.SCANNER_CLI_RUNTIME).toBe("host");
    expect(() => loadEnv({ CLAMAV_REST_URL: "clamav:3310" })).toThrow();
    expect(() => loadEnv({ TRIVY_SERVER_URL: "trivy:4954" })).toThrow();
    expect(() => loadEnv({ SCANNER_CLI_RUNTIME: "local" })).toThrow();
  });

  test("registry upload limit is a positive integer", () => {
    expect(loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "1048576" }).REGISTRY_MAX_UPLOAD_BYTES).toBe(
      1048576,
    );
    expect(() => loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "0" })).toThrow();
    expect(() => loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "-1" })).toThrow();
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
    });
    expect(env.AUTH_LOGIN_MAX_ATTEMPTS).toBe(7);
    expect(env.AUTH_LOGIN_WINDOW_SECONDS).toBe(120);
    expect(() => loadEnv({ AUTH_LOGIN_MAX_ATTEMPTS: "0" })).toThrow();
    expect(() => loadEnv({ AUTH_LOGIN_WINDOW_SECONDS: "-1" })).toThrow();
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
    expect(env.APP_PUBLIC_URL).toBe("https://hoot.example.test");
    expect(() => loadEnv({ EMAIL_ENABLED: "true" })).toThrow(/EMAIL_SMTP_HOST/);
    expect(() => loadEnv({ EMAIL_SMTP_PORT: "0" })).toThrow();
    expect(() => loadEnv({ APP_PUBLIC_URL: "notaurl" })).toThrow();
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
        developers: [{ org: "acme", role: "developer" }],
        admins: [
          { org: "acme", role: "owner" },
          { org: "tools", role: "admin" },
        ],
      }),
    });
    expect(env.AUTH_OIDC_ENABLED).toBe(true);
    expect(env.AUTH_OIDC_NAME).toBe("Zitadel");
    expect(env.AUTH_OIDC_ISSUER).toBe("http://idp.test");
    expect(env.AUTH_OIDC_SCOPES).toEqual(["openid", "email", "profile", "groups"]);
    expect(env.AUTH_OIDC_GROUP_MAPPINGS.admins?.[1]).toEqual({
      org: "tools",
      role: "admin",
    });
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
          admins: [{ org: "acme", role: "owner" }],
        }),
      }),
    ).toThrow(/AUTH_OIDC_ISSUER must use https/);
  });
});
