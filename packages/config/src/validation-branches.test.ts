import { describe, expect, test } from "bun:test";
import { loadEnv } from ".";

const prodSource = {
  NODE_ENV: "production",
  SESSION_SECRET: "prod-session-secret-with-enough-entropy",
  S3_ACCESS_KEY_ID: "prod-access-key",
  S3_SECRET_ACCESS_KEY: "prod-secret-key",
  DATABASE_URL: "postgres://prod_user:prod_password@localhost:5432/hootifactory",
  REGISTRY_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----",
  REGISTRY_JWT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----",
};

describe("boolish coercion", () => {
  test("accepts a wide range of truthy and falsy string forms", () => {
    for (const truthy of ["TRUE", "1", "Yes", "on", "Y"]) {
      expect(loadEnv({ OTEL_SDK_DISABLED: truthy }).OTEL_SDK_DISABLED).toBe(true);
    }
    for (const falsy of ["false", "0", "NO", "off", "n", ""]) {
      expect(loadEnv({ OTEL_SDK_DISABLED: falsy }).OTEL_SDK_DISABLED).toBe(false);
    }
  });

  test("passes through a real boolean value untouched", () => {
    expect(loadEnv({ OTEL_SDK_DISABLED: true as unknown as string }).OTEL_SDK_DISABLED).toBe(true);
  });

  test("rejects an unrecognized boolean string loudly", () => {
    expect(() => loadEnv({ SCANNER_ENABLED: "ture" })).toThrow(/expected a boolean, got "ture"/);
  });
});

describe("OIDC group mappings parsing", () => {
  test("rejects invalid JSON", () => {
    expect(() =>
      loadEnv({
        AUTH_OIDC_GROUP_MAPPINGS: "{not valid json",
      }),
    ).toThrow(/AUTH_OIDC_GROUP_MAPPINGS must be valid JSON/);
  });

  test("rejects structurally invalid mappings with a prefixed path", () => {
    // org slug too short -> schema failure, issues re-pathed under the env key.
    expect(() =>
      loadEnv({
        AUTH_OIDC_GROUP_MAPPINGS: JSON.stringify({
          devs: [{ org: "a", role: "developer" }],
        }),
      }),
    ).toThrow(/AUTH_OIDC_GROUP_MAPPINGS/);

    // unknown role -> schema failure.
    expect(() =>
      loadEnv({
        AUTH_OIDC_GROUP_MAPPINGS: JSON.stringify({
          devs: [{ org: "acme", role: "not-a-role" }],
        }),
      }),
    ).toThrow(/AUTH_OIDC_GROUP_MAPPINGS/);
  });

  test("blank value parses to an empty mapping", () => {
    expect(loadEnv({ AUTH_OIDC_GROUP_MAPPINGS: "   " }).AUTH_OIDC_GROUP_MAPPINGS).toEqual({});
  });
});

describe("registry JWT keypair invariants", () => {
  test("private without public is rejected", () => {
    expect(() => loadEnv({ REGISTRY_JWT_PRIVATE_KEY: "priv" })).toThrow(/must be set together/);
  });

  test("public without private is rejected", () => {
    expect(() => loadEnv({ REGISTRY_JWT_PUBLIC_KEY: "pub" })).toThrow(/must be set together/);
  });

  test("both unset in production is rejected", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        SESSION_SECRET: "prod-session-secret-with-enough-entropy",
        S3_ACCESS_KEY_ID: "prod-access-key",
        S3_SECRET_ACCESS_KEY: "prod-secret-key",
        DATABASE_URL: "postgres://prod_user:prod_password@localhost:5432/hootifactory",
      }),
    ).toThrow(/required when NODE_ENV=production/);
  });

  test("a valid production keypair is accepted", () => {
    const env = loadEnv(prodSource);
    expect(env.REGISTRY_JWT_PRIVATE_KEY).toContain("PRIVATE KEY");
    expect(env.REGISTRY_JWT_PUBLIC_KEY).toContain("PUBLIC KEY");
  });
});

describe("database dev-default credential detection edge cases", () => {
  test("dev-default username is detected", () => {
    expect(() =>
      loadEnv({
        ...prodSource,
        DATABASE_URL: "postgres://hootifactory:pass@db:5432/hootifactory",
      }),
    ).toThrow(/dev-default database username or password/);
  });

  test("non-postgres-protocol URLs are rejected by the schema", () => {
    expect(() => loadEnv({ DATABASE_URL: "mysql://user:pass@db:3306/app" })).toThrow(
      /must be a postgres:\/\/ connection URL/,
    );
  });

  test("dev-default password is detected", () => {
    expect(() =>
      loadEnv({
        ...prodSource,
        DATABASE_URL: "postgres://prod_user:hootifactory@db:5432/hootifactory",
      }),
    ).toThrow(/dev-default database username or password/);
  });

  test("a non-dev production credential pair is accepted", () => {
    const env = loadEnv({
      ...prodSource,
      DATABASE_URL: "postgresql://alice:s3cret@db:5432/hootifactory",
    });
    expect(env.DATABASE_URL).toContain("postgresql://");
  });
});

describe("exported environment flags", () => {
  test("isProduction and isTest are mutually exclusive booleans", async () => {
    const mod = await import(".");
    expect(typeof mod.isProduction).toBe("boolean");
    expect(typeof mod.isTest).toBe("boolean");
    expect(mod.isProduction && mod.isTest).toBe(false);
  });

  test("the exported env object is frozen", async () => {
    const mod = await import(".");
    expect(Object.isFrozen(mod.env)).toBe(true);
  });
});
