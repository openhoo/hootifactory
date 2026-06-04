import { describe, expect, test } from "bun:test";
import { ARTIFACT_STATES, SEVERITIES } from "@hootifactory/scan-core";
import {
  AUTH_EMAIL_TOKEN_PURPOSES,
  REPO_KINDS,
  ROLE_NAMES,
  TOKEN_TYPES,
  VISIBILITIES,
} from "@hootifactory/types";
import {
  artifactStateEnum,
  authEmailTokenPurposeEnum,
  repoKindEnum,
  roleNameEnum,
  severityEnum,
  tokenTypeEnum,
  visibilityEnum,
} from "./enums";

describe("database enum contracts", () => {
  test("keeps authorization and policy enums stable", () => {
    expect(repoKindEnum.enumValues).toEqual([...REPO_KINDS]);
    expect(visibilityEnum.enumValues).toEqual([...VISIBILITIES]);
    expect(roleNameEnum.enumValues).toEqual([...ROLE_NAMES]);
    expect(tokenTypeEnum.enumValues).toEqual([...TOKEN_TYPES]);
    expect(authEmailTokenPurposeEnum.enumValues).toEqual([...AUTH_EMAIL_TOKEN_PURPOSES]);
    expect(severityEnum.enumValues).toEqual([...SEVERITIES]);
    expect(artifactStateEnum.enumValues).toEqual([...ARTIFACT_STATES]);
  });
});
