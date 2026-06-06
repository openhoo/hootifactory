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

  test("matches the auth scheme case-insensitively while preserving credential bytes", () => {
    // RFC 7235/6750/7617: the auth-scheme token is case-insensitive, but the
    // credential bytes (Bearer token, Basic base64) must be preserved exactly.
    const bearerToken = "Registry.JWT.Token";
    expect(parseAuthorizationHeader(`bearer ${bearerToken}`)).toEqual({
      kind: "bearer",
      token: bearerToken,
    });
    expect(parseAuthorizationHeader(`bearer ${bearerToken}`)).toEqual(
      parseAuthorizationHeader(`Bearer ${bearerToken}`),
    );

    const basicCreds = basic("__token__:HootSecret");
    expect(parseAuthorizationHeader(`basic ${basicCreds}`)).toEqual({
      kind: "basic",
      username: "__token__",
      password: "HootSecret",
    });
    expect(parseAuthorizationHeader(`basic ${basicCreds}`)).toEqual(
      parseAuthorizationHeader(`Basic ${basicCreds}`),
    );

    // Mixed-case schemes resolve identically too.
    expect(parseAuthorizationHeader(`BeArEr ${bearerToken}`)).toEqual({
      kind: "bearer",
      token: bearerToken,
    });

    // An unknown scheme still yields invalid regardless of casing.
    expect(parseAuthorizationHeader("digest abc")).toEqual({ kind: "invalid" });
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
