import {
  ARTIFACT_STATES,
  FINDING_TYPES,
  POLICY_MODES,
  SCAN_STATUSES,
  SCAN_TYPES,
  SEVERITIES,
} from "@hootifactory/scan-core";
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
import { pgEnum } from "drizzle-orm/pg-core";

export const repoKindEnum = pgEnum("repo_kind", REPO_KINDS);

export const visibilityEnum = pgEnum("visibility", VISIBILITIES);

/** Fixed RBAC role matrix (resolved to permissions in code). */
export const roleNameEnum = pgEnum("role_name", ROLE_NAMES);

export const tokenTypeEnum = pgEnum("token_type", TOKEN_TYPES);

export const authEmailTokenPurposeEnum = pgEnum(
  "auth_email_token_purpose",
  AUTH_EMAIL_TOKEN_PURPOSES,
);

export const blobStateEnum = pgEnum("blob_state", BLOB_STATES);

export const uploadStateEnum = pgEnum("upload_state", UPLOAD_STATES);

export const scanStatusEnum = pgEnum("scan_status", SCAN_STATUSES);

export const scanTypeEnum = pgEnum("scan_type", SCAN_TYPES);

export const findingTypeEnum = pgEnum("finding_type", FINDING_TYPES);

export const severityEnum = pgEnum("severity", SEVERITIES);

export const artifactStateEnum = pgEnum("artifact_state", ARTIFACT_STATES);

export const policyModeEnum = pgEnum("policy_mode", POLICY_MODES);

export const auditResultEnum = pgEnum("audit_result", AUDIT_RESULTS);
