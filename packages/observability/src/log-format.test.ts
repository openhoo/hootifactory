import { describe, expect, test } from "bun:test";
import {
  attributesForMeta,
  isSensitiveLogKey,
  safeJsonStringify,
  sanitizeForJson,
} from "./log-format";

describe("log formatting helpers", () => {
  test("sanitizes circular, binary, bigint, and throwing metadata", () => {
    const value: Record<string, unknown> = {
      bytes: new Uint8Array([1, 2, 3]),
      count: 3n,
    };
    value.self = value;
    Object.defineProperty(value, "danger", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    expect(sanitizeForJson(value)).toEqual({
      bytes: { type: "Uint8Array", byteLength: 3 },
      count: "3",
      self: "[Circular]",
      danger: "[Thrown: getter failed]",
    });
  });

  test("extracts bounded OpenTelemetry attributes from scalar and structured metadata", () => {
    const attrs = attributesForMeta({
      moduleId: "npm",
      durationMs: 12.5,
      ok: true,
      nested: { value: "kept" },
      error: new Error("broken"),
    });

    expect(attrs).toMatchObject({
      "exception.type": "Error",
      "exception.message": "broken",
      "meta.moduleId": "npm",
      "meta.durationMs": 12.5,
      "meta.ok": true,
      "meta.nested": '{"value":"kept"}',
    });
  });

  test("redacts sensitive keys in nested meta objects and arrays", () => {
    expect(
      sanitizeForJson({
        request: {
          headers: { Authorization: "Bearer abc", "set-cookie": "sid=1", accept: "text/html" },
        },
        attempts: [{ password: "hunter2", user: "owl" }, { refresh_token: "r-1" }],
        credentials: { accessKeyId: "AKIA", secretAccessKey: "shhh" },
      }),
    ).toEqual({
      request: {
        headers: { Authorization: "[redacted]", "set-cookie": "[redacted]", accept: "text/html" },
      },
      attempts: [{ password: "[redacted]", user: "owl" }, { refresh_token: "[redacted]" }],
      credentials: "[redacted]",
    });
  });

  test("redacts non-string sensitive values wholesale", () => {
    expect(
      sanitizeForJson({
        apiToken: 12345,
        clientSecret: { id: "c1", value: "v" },
        passwordHistory: ["a", "b"],
      }),
    ).toEqual({
      apiToken: "[redacted]",
      clientSecret: "[redacted]",
      passwordHistory: "[redacted]",
    });
  });

  test("keeps innocuous keys that merely contain sensitive substrings", () => {
    const meta = {
      tokenCount: 42,
      totalTokens: 1337,
      inputTokens: 10,
      tokenizer: "bpe",
      secretive: "adjective",
      cookbook: "recipes",
    };
    expect(sanitizeForJson(meta)).toEqual(meta);
  });

  test("isSensitiveLogKey applies word-boundary matching", () => {
    for (const key of [
      "authorization",
      "Authorization",
      "set-cookie",
      "cookies",
      "PASSWORD",
      "db_password",
      "clientSecret",
      "secret_key",
      "credential",
      "credentials",
      "token",
      "accessToken",
      "refresh_token",
      "x-auth-token",
    ]) {
      expect(isSensitiveLogKey(key)).toBe(true);
    }
    for (const key of [
      "tokenCount",
      "totalTokens",
      "tokenizer",
      "secretive",
      "cookbook",
      "passwordless" /* word "passwordless" is a feature name, not a value */,
      "user",
    ]) {
      expect(isSensitiveLogKey(key)).toBe(false);
    }
  });

  test("redaction flows through to OpenTelemetry attributes", () => {
    expect(
      attributesForMeta({ moduleId: "npm", authorization: "Bearer abc", nested: { token: "t" } }),
    ).toMatchObject({
      "meta.moduleId": "npm",
      "meta.authorization": "[redacted]",
      "meta.nested": '{"token":"[redacted]"}',
    });
  });

  test("returns a fallback log line when JSON serialization fails", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(JSON.parse(safeJsonStringify(cyclic))).toMatchObject({
      level: "error",
      msg: "failed to serialize log line",
      meta: "JSON.stringify cannot serialize cyclic structures.",
    });
  });
});
