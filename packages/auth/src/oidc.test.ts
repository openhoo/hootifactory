import { describe, expect, test } from "bun:test";
import {
  extractGroups,
  mapGroupsToOrgRoles,
  mapGroupsToRole,
  safeOidcReturnTo,
  signOidcState,
  verifyOidcState,
} from "./oidc";

describe("OIDC group -> role mapping", () => {
  const map = {
    "platform-admins": "owner",
    developers: "developer",
    everyone: "viewer",
  };

  test("highest-privilege matching group wins", () => {
    expect(mapGroupsToRole(["everyone", "developers"], map)).toBe("developer");
    expect(mapGroupsToRole(["developers", "platform-admins"], map)).toBe("owner");
    expect(mapGroupsToRole(["everyone"], map)).toBe("viewer");
  });

  test("no matching group -> null", () => {
    expect(mapGroupsToRole(["unknown"], map)).toBeNull();
    expect(mapGroupsToRole([], map)).toBeNull();
  });

  test("extractGroups handles array, string, and missing claims", () => {
    expect(extractGroups({ groups: ["a", "b"] }, "groups")).toEqual(["a", "b"]);
    expect(extractGroups({ roles: "admin" }, "roles")).toEqual(["admin"]);
    expect(extractGroups({ realm: { roles: ["admin"] } }, "realm.roles")).toEqual(["admin"]);
    expect(extractGroups({}, "groups")).toEqual([]);
  });

  test("multi-org mappings keep the highest role per org", () => {
    expect(
      mapGroupsToOrgRoles(["everyone", "developers", "platform-admins"], {
        everyone: [{ org: "acme", role: "viewer" }],
        developers: [
          { org: "acme", role: "developer" },
          { org: "tools", role: "developer" },
        ],
        "platform-admins": [{ org: "acme", role: "owner" }],
      }),
    ).toEqual([
      { org: "acme", role: "owner", groups: ["platform-admins"] },
      { org: "tools", role: "developer", groups: ["developers"] },
    ]);
  });

  test("returnTo validation rejects absolute and scheme-relative URLs", () => {
    expect(safeOidcReturnTo("/repositories?x=1")).toBe("/repositories?x=1");
    expect(safeOidcReturnTo("https://evil.test")).toBe("/");
    expect(safeOidcReturnTo("//evil.test/path")).toBe("/");
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
    expect(verifyOidcState(`${signed.slice(0, -1)}0`, "test-secret")).toBeNull();
    expect(verifyOidcState(signed, "wrong-secret")).toBeNull();
    expect(verifyOidcState(signed, "test-secret", payload.expiresAt + 1)).toBeNull();
  });
});
