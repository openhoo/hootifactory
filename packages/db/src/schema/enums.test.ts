import { describe, expect, test } from "bun:test";
import { REPO_KINDS, ROLE_NAMES, VISIBILITIES } from "@hootifactory/types";
import {
  artifactStateEnum,
  repoKindEnum,
  roleNameEnum,
  severityEnum,
  visibilityEnum,
} from "./enums";

describe("database enum contracts", () => {
  test("keeps authorization and policy enums stable", () => {
    expect(repoKindEnum.enumValues).toEqual([...REPO_KINDS]);
    expect(visibilityEnum.enumValues).toEqual([...VISIBILITIES]);
    expect(roleNameEnum.enumValues).toEqual([...ROLE_NAMES]);
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
