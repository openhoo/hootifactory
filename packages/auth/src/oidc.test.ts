import { describe, expect, test } from "bun:test";
import { extractGroups, mapGroupsToRole } from "./oidc";

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
    expect(extractGroups({}, "groups")).toEqual([]);
  });
});
