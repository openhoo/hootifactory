import { describe, expect, test } from "bun:test";
import { mapGroupsToOrgGroups } from "./oidc-claims";

describe("mapGroupsToOrgGroups edge cases", () => {
  test("merges contributing IdP groups when they map to the same local group", () => {
    expect(
      mapGroupsToOrgGroups(["team-a", "team-b"], {
        "team-a": [{ org: "acme", group: "developers" }],
        "team-b": [{ org: "acme", group: "developers" }],
      }),
    ).toEqual([{ org: "acme", group: "developers", groups: ["team-a", "team-b"] }]);
  });

  test("ignores duplicate group names without double-listing them", () => {
    expect(
      mapGroupsToOrgGroups(["team-a", "team-a"], {
        "team-a": [{ org: "acme", group: "developers" }],
      }),
    ).toEqual([{ org: "acme", group: "developers", groups: ["team-a"] }]);
  });

  test("keeps distinct target groups for the same organization", () => {
    expect(
      mapGroupsToOrgGroups(["viewers", "admins"], {
        viewers: [{ org: "acme", group: "viewers" }],
        admins: [{ org: "acme", group: "admins" }],
      }),
    ).toEqual([
      { org: "acme", group: "viewers", groups: ["viewers"] },
      { org: "acme", group: "admins", groups: ["admins"] },
    ]);
  });

  test("groups with no mapping contribute nothing", () => {
    expect(
      mapGroupsToOrgGroups(["unmapped"], { mapped: [{ org: "acme", group: "viewers" }] }),
    ).toEqual([]);
  });
});
