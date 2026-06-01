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
    expect(loadEnv({ NODE_ENV: "development" }).AUTH_ALLOW_REGISTRATION).toBe(true);
    expect(loadEnv({ NODE_ENV: "development" }).AUTH_ALLOW_ORG_CREATION).toBe(true);
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
});
