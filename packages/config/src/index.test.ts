import { describe, expect, test } from "bun:test";
import { loadEnv } from "./index";

const prodSource = {
  NODE_ENV: "production",
  SESSION_SECRET: "prod-session-secret-with-enough-entropy",
  S3_ACCESS_KEY_ID: "prod-access-key",
  S3_SECRET_ACCESS_KEY: "prod-secret-key",
  REGISTRY_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----",
  REGISTRY_JWT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----",
};

describe("environment auth creation defaults", () => {
  test("development and test allow self-service creation by default", () => {
    const devEnv = loadEnv({ NODE_ENV: "development" });
    expect(devEnv.AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(devEnv.AUTH_ALLOW_ORG_CREATION).toBe(true);
    expect(devEnv.REGISTRY_MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(devEnv.SCAN_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(loadEnv({ NODE_ENV: "test" }).AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(loadEnv({ NODE_ENV: "test" }).AUTH_ALLOW_ORG_CREATION).toBe(true);
  });

  test("production disables self-service creation by default", () => {
    const env = loadEnv(prodSource);
    expect(env.AUTH_ALLOW_REGISTRATION).toBe(false);
    expect(env.AUTH_ALLOW_ORG_CREATION).toBe(false);
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
    });
    expect(env.CLAMAV_REST_URL).toBe("http://clamav:3310/scan");
    expect(env.TRIVY_SERVER_URL).toBe("http://trivy:4954");
    expect(() => loadEnv({ CLAMAV_REST_URL: "clamav:3310" })).toThrow();
    expect(() => loadEnv({ TRIVY_SERVER_URL: "trivy:4954" })).toThrow();
  });

  test("registry upload limit is a positive integer", () => {
    expect(loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "1048576" }).REGISTRY_MAX_UPLOAD_BYTES).toBe(
      1048576,
    );
    expect(() => loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "0" })).toThrow();
    expect(() => loadEnv({ REGISTRY_MAX_UPLOAD_BYTES: "-1" })).toThrow();
  });
});
