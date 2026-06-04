import { describe, expect, test } from "bun:test";
import { ARTIFACT_STATES, SCAN_STATUSES, SCAN_TYPES, SEVERITIES } from "@hootifactory/scan-core";
import {
  AUDIT_RESULTS,
  AUTH_EMAIL_TOKEN_PURPOSES,
  BLOB_STATES,
  REPO_KINDS,
  ROLE_NAMES,
  TOKEN_TYPES,
  UPLOAD_STATES,
  VISIBILITIES,
} from "@hootifactory/types";
import {
  artifactStateEnum,
  auditResultEnum,
  authEmailTokenPurposeEnum,
  blobStateEnum,
  repoKindEnum,
  roleNameEnum,
  scanStatusEnum,
  scanTypeEnum,
  severityEnum,
  tokenTypeEnum,
  uploadStateEnum,
  visibilityEnum,
} from "./enums";

describe("database enum contracts", () => {
  test("keeps authorization and policy enums stable", () => {
    expect(repoKindEnum.enumValues).toEqual([...REPO_KINDS]);
    expect(visibilityEnum.enumValues).toEqual([...VISIBILITIES]);
    expect(roleNameEnum.enumValues).toEqual([...ROLE_NAMES]);
    expect(tokenTypeEnum.enumValues).toEqual([...TOKEN_TYPES]);
    expect(authEmailTokenPurposeEnum.enumValues).toEqual([...AUTH_EMAIL_TOKEN_PURPOSES]);
    expect(blobStateEnum.enumValues).toEqual([...BLOB_STATES]);
    expect(uploadStateEnum.enumValues).toEqual([...UPLOAD_STATES]);
    expect(scanStatusEnum.enumValues).toEqual([...SCAN_STATUSES]);
    expect(scanTypeEnum.enumValues).toEqual([...SCAN_TYPES]);
    expect(severityEnum.enumValues).toEqual([...SEVERITIES]);
    expect(artifactStateEnum.enumValues).toEqual([...ARTIFACT_STATES]);
    expect(auditResultEnum.enumValues).toEqual([...AUDIT_RESULTS]);
  });
});
