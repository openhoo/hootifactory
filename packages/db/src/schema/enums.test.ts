import { describe, expect, test } from "bun:test";
import { artifactStateEnum, repoKindEnum, roleNameEnum, severityEnum } from "./enums";

describe("database enum contracts", () => {
  test("keeps authorization and policy enums stable", () => {
    expect(repoKindEnum.enumValues).toEqual(["hosted", "proxy", "virtual"]);
    expect(roleNameEnum.enumValues).toEqual(["viewer", "developer", "admin", "owner"]);
    expect(severityEnum.enumValues).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "negligible",
      "unknown",
    ]);
    expect(artifactStateEnum.enumValues).toEqual(["pending", "clean", "quarantined", "blocked"]);
  });
});
