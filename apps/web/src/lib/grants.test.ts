import { describe, expect, test } from "bun:test";
import type { TokenGrant } from "@/lib/api";
import { grantLabel, grantNeedsRepository, grantsSummary } from "./grants";

describe("grantNeedsRepository", () => {
  test("repository-scoped permission families need a repository", () => {
    expect(grantNeedsRepository("repository.read")).toBe(true);
    expect(grantNeedsRepository("package.write")).toBe(true);
    expect(grantNeedsRepository("artifact.read")).toBe(true);
    expect(grantNeedsRepository("policy.write")).toBe(true);
  });

  test("org-wide permissions do not", () => {
    expect(grantNeedsRepository("org.read")).toBe(false);
    expect(grantNeedsRepository("token.create")).toBe(false);
    expect(grantNeedsRepository("system.admin")).toBe(false);
  });
});

describe("grantLabel", () => {
  test("appends the first present scope in precedence order", () => {
    expect(grantLabel({ permission: "repository.read", repository: "team/*" })).toBe(
      "repository.read (team/*)",
    );
    expect(grantLabel({ permission: "package.read", package: "pkg" } as TokenGrant)).toBe(
      "package.read (pkg)",
    );
    expect(grantLabel({ permission: "policy.write", policy: "scan" } as TokenGrant)).toBe(
      "policy.write (scan)",
    );
  });

  test("renders bare permission when there is no scope", () => {
    expect(grantLabel({ permission: "org.read" })).toBe("org.read");
  });
});

describe("grantsSummary", () => {
  test("joins grant labels and handles the empty case", () => {
    expect(grantsSummary([])).toBe("no grants");
    expect(
      grantsSummary([
        { permission: "repository.read", repository: "a" },
        { permission: "org.read" },
      ]),
    ).toBe("repository.read (a); org.read");
  });
});
