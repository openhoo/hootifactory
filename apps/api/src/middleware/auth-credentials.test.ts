import { describe, expect, test } from "bun:test";
import {
  decodeBasicCredentials,
  parseAuthorizationHeader,
  parseRegistryApiKeyHeader,
} from "./auth-credentials";

function basic(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("authentication credential parsing", () => {
  test("parses bearer, basic, and bare-token authorization headers", () => {
    expect(parseAuthorizationHeader(" Bearer registry.jwt.token ")).toEqual({
      kind: "bearer",
      token: "registry.jwt.token",
    });
    expect(parseAuthorizationHeader(`Basic ${basic("__token__:hoot_secret")}`)).toEqual({
      kind: "basic",
      username: "__token__",
      password: "hoot_secret",
    });
    expect(parseAuthorizationHeader("hoot_secret")).toEqual({
      kind: "bareToken",
      token: "hoot_secret",
    });
  });

  test("rejects malformed authorization headers without leaking partial credentials", () => {
    expect(parseAuthorizationHeader(undefined)).toBeNull();
    expect(parseAuthorizationHeader("")).toEqual({ kind: "invalid" });
    expect(parseAuthorizationHeader("Digest abc")).toEqual({ kind: "invalid" });
    expect(parseAuthorizationHeader(`Basic ${basic("missing-colon")}`)).toEqual({
      kind: "invalid",
    });
    expect(parseAuthorizationHeader("Basic not-base64")).toEqual({ kind: "invalid" });
  });

  test("decodes UTF-8 basic credentials and rejects invalid byte sequences", () => {
    expect(decodeBasicCredentials(basic("alice:p\u00e4ss"))).toBe("alice:p\u00e4ss");
    expect(decodeBasicCredentials("//")).toBeNull();
  });

  test("parses only Hootifactory tokens from registry API-key headers", () => {
    expect(parseRegistryApiKeyHeader(undefined)).toBeNull();
    expect(parseRegistryApiKeyHeader(" hoot_secret ")).toEqual({
      kind: "token",
      token: "hoot_secret",
    });
    expect(parseRegistryApiKeyHeader("not-a-hoot-token")).toEqual({ kind: "invalid" });
    expect(parseRegistryApiKeyHeader("")).toEqual({ kind: "invalid" });
  });
});
