import { describe, expect, test } from "bun:test";
import { mapGroupsToOrgRoles } from "./oidc-claims";

describe("mapGroupsToOrgRoles edge cases", () => {
  test("merges the contributing groups when two groups map to the same org and role", () => {
    expect(
      mapGroupsToOrgRoles(["team-a", "team-b"], {
        "team-a": [{ org: "acme", role: "developer" }],
        "team-b": [{ org: "acme", role: "developer" }],
      }),
    ).toEqual([{ org: "acme", role: "developer", groups: ["team-a", "team-b"] }]);
  });

  test("ignores duplicate group names without double-listing them", () => {
    expect(
      mapGroupsToOrgRoles(["team-a", "team-a"], {
        "team-a": [{ org: "acme", role: "developer" }],
      }),
    ).toEqual([{ org: "acme", role: "developer", groups: ["team-a"] }]);
  });

  test("a stronger role replaces a weaker one and resets the contributing group", () => {
    expect(
      mapGroupsToOrgRoles(["viewers", "admins"], {
        viewers: [{ org: "acme", role: "viewer" }],
        admins: [{ org: "acme", role: "admin" }],
      }),
    ).toEqual([{ org: "acme", role: "admin", groups: ["admins"] }]);
  });

  test("groups with no mapping contribute nothing", () => {
    expect(
      mapGroupsToOrgRoles(["unmapped"], { mapped: [{ org: "acme", role: "viewer" }] }),
    ).toEqual([]);
  });
});
