import { pgEnum } from "drizzle-orm/pg-core";

export const repoKindEnum = pgEnum("repo_kind", ["hosted", "proxy", "virtual"]);

export const packageFormatEnum = pgEnum("package_format", [
  "npm",
  "docker",
  "oci",
  "pypi",
  "maven",
  "helm",
  "nuget",
  "go",
  "cargo",
  "generic",
]);

export const visibilityEnum = pgEnum("visibility", ["private", "public"]);

/** Fixed RBAC role matrix (resolved to permissions in code). */
export const roleNameEnum = pgEnum("role_name", ["viewer", "developer", "admin", "owner"]);

export const tokenTypeEnum = pgEnum("token_type", ["personal", "robot"]);

export const authEmailTokenPurposeEnum = pgEnum("auth_email_token_purpose", [
  "password_reset",
  "oidc_link",
]);

export const blobStateEnum = pgEnum("blob_state", ["active", "pending_delete"]);

export const blobRefKindEnum = pgEnum("blob_ref_kind", [
  "oci_layer",
  "oci_config",
  "oci_manifest",
  "npm_tarball",
  "pypi_file",
  "generic_file",
]);

export const uploadStateEnum = pgEnum("upload_state", ["open", "closed", "committed", "aborted"]);

export const scanStatusEnum = pgEnum("scan_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped_dedup",
]);

export const scanTypeEnum = pgEnum("scan_type", ["sbom", "vuln", "malware", "license", "secret"]);

export const findingTypeEnum = pgEnum("finding_type", ["vuln", "license", "secret", "malware"]);

export const severityEnum = pgEnum("severity", [
  "critical",
  "high",
  "medium",
  "low",
  "negligible",
  "unknown",
]);

export const artifactStateEnum = pgEnum("artifact_state", [
  "pending",
  "clean",
  "quarantined",
  "blocked",
]);

export const policyModeEnum = pgEnum("policy_mode", ["audit", "enforce"]);

export const auditResultEnum = pgEnum("audit_result", ["allow", "deny", "success", "failure"]);
