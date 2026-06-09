import { describe, expect, test } from "bun:test";
import {
  extractGroups,
  extractStringClaim,
  mapGroupsToOrgGroups,
  safeOidcReturnTo,
  signOidcState,
  verifyOidcState,
} from "./oidc";

describe("OIDC group -> local group mapping", () => {
  test("extractGroups handles array, string, and missing claims", () => {
    expect(extractGroups({ groups: ["a", "b"] }, "groups")).toEqual(["a", "b"]);
    expect(extractGroups({ roles: "admin" }, "roles")).toEqual(["admin"]);
    expect(extractGroups({ realm: { roles: ["admin"] } }, "realm.roles")).toEqual(["admin"]);
    expect(extractGroups({}, "groups")).toEqual([]);
  });

  test("extractStringClaim trims nested string claims and rejects non-strings", () => {
    expect(
      extractStringClaim({ profile: { email: " Alice@example.TEST " } }, "profile.email"),
    ).toBe("Alice@example.TEST");
    expect(extractStringClaim({ profile: { email: "" } }, "profile.email")).toBeNull();
    expect(extractStringClaim({ profile: { email: 123 } }, "profile.email")).toBeNull();
  });

  test("multi-org mappings keep each distinct local group", () => {
    expect(
      mapGroupsToOrgGroups(["everyone", "developers", "platform-admins"], {
        everyone: [{ org: "acme", group: "viewers" }],
        developers: [
          { org: "acme", group: "developers" },
          { org: "tools", group: "developers" },
        ],
        "platform-admins": [{ org: "acme", group: "admins" }],
      }),
    ).toEqual([
      { org: "acme", group: "viewers", groups: ["everyone"] },
      { org: "acme", group: "developers", groups: ["developers"] },
      { org: "tools", group: "developers", groups: ["developers"] },
      { org: "acme", group: "admins", groups: ["platform-admins"] },
    ]);
  });

  test("returnTo validation rejects absolute and scheme-relative URLs", () => {
    expect(safeOidcReturnTo("/repositories?x=1#top")).toBe("/repositories?x=1#top");
    expect(safeOidcReturnTo("https://evil.test")).toBe("/");
    expect(safeOidcReturnTo("//evil.test/path")).toBe("/");
    expect(safeOidcReturnTo("")).toBe("/");
    expect(safeOidcReturnTo(null)).toBe("/");
  });

  test("signed OIDC state verifies and rejects tampering or expiry", () => {
    const payload = {
      state: "state",
      nonce: "nonce",
      codeVerifier: "verifier",
      returnTo: "/",
      expiresAt: Date.now() + 60_000,
    };
    const signed = signOidcState(payload, "test-secret");
    expect(verifyOidcState(signed, "test-secret")).toEqual(payload);
    // Corrupt the final signature character with a guaranteed-different hex digit
    // so the HMAC never matches. (A fixed "0" was a no-op ~1/16 of the time, when
    // the signature already ended in "0" — the source of the flake.)
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("0") ? "1" : "0"}`;
    expect(verifyOidcState(tampered, "test-secret")).toBeNull();
    expect(verifyOidcState(signed, "wrong-secret")).toBeNull();
    expect(verifyOidcState(`${signed}.extra`, "test-secret")).toBeNull();
    expect(verifyOidcState("not-json.signature", "test-secret")).toBeNull();
    expect(verifyOidcState(signed, "test-secret", payload.expiresAt + 1)).toBeNull();
    expect(
      verifyOidcState(
        signOidcState({ ...payload, returnTo: "https://evil.test" }, "test-secret"),
        "test-secret",
      ),
    ).toBeNull();
    expect(
      verifyOidcState(
        signOidcState({ ...payload, extra: true } as typeof payload, "test-secret"),
        "test-secret",
      ),
    ).toBeNull();
  });
});
