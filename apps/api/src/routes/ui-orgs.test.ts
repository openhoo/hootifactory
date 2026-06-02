import { describe, expect, test } from "bun:test";
import { mergeAccessibleOrgs } from "./ui-orgs";

describe("accessible org listing", () => {
  test("deduplicates local and external grants by strongest role and sorts by slug", () => {
    expect(
      mergeAccessibleOrgs(
        [
          { id: "org-2", slug: "zeta", displayName: "Zeta", role: "admin" },
          { id: "org-1", slug: "alpha", displayName: "Alpha", role: "viewer" },
        ],
        [
          { id: "org-1", slug: "alpha", displayName: "Alpha", role: "developer" },
          { id: "org-3", slug: "middle", displayName: "Middle", role: "owner" },
        ],
      ),
    ).toEqual([
      { id: "org-1", slug: "alpha", displayName: "Alpha", role: "developer" },
      { id: "org-3", slug: "middle", displayName: "Middle", role: "owner" },
      { id: "org-2", slug: "zeta", displayName: "Zeta", role: "admin" },
    ]);
  });

  test("keeps local membership when it outranks an external grant", () => {
    expect(
      mergeAccessibleOrgs(
        [{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "owner" }],
        [{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "viewer" }],
      ),
    ).toEqual([{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "owner" }]);
  });
});
