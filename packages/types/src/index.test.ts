import { describe, expect, test } from "bun:test";
import {
  ACTIONS,
  AUDIT_RESULT,
  AUDIT_RESULTS,
  AUTH_EMAIL_TOKEN_PURPOSE,
  AUTH_EMAIL_TOKEN_PURPOSES,
  BLOB_STATE,
  BLOB_STATES,
  EMAIL_TEMPLATE,
  EMAIL_TEMPLATES,
  isAction,
  isAuditResult,
  isAuthEmailTokenPurpose,
  isBlobState,
  isEmailTemplate,
  isLogLevel,
  isPolicyName,
  isRepoKind,
  isScannerCliRuntime,
  isTokenTarget,
  isUploadState,
  isVisibility,
  LOG_LEVELS,
  POLICY_NAMES,
  REPO_KINDS,
  type RegistryModuleId,
  SCANNER_CLI_RUNTIMES,
  TOKEN_TARGETS,
  TOKEN_TYPES,
  UPLOAD_STATE,
  UPLOAD_STATES,
  VISIBILITIES,
} from "./index";

describe("shared type constants", () => {
  test("keeps shared RBAC and repository enum values stable", () => {
    expect(REPO_KINDS).toEqual(["hosted", "proxy", "virtual"]);
    expect(VISIBILITIES).toEqual(["private", "public"]);
    expect(ACTIONS).toEqual(["read", "write", "delete", "admin"]);
    expect(TOKEN_TYPES).toEqual(["personal", "robot"]);
    expect(BLOB_STATES).toEqual(["active", "pending_delete"]);
    expect(BLOB_STATE.pendingDelete).toBe("pending_delete");
    expect(UPLOAD_STATES).toEqual(["open", "closed", "committed", "aborted"]);
    expect(UPLOAD_STATE.committed).toBe("committed");
    expect(AUDIT_RESULTS).toEqual(["allow", "deny", "success", "failure"]);
    expect(AUDIT_RESULT.failure).toBe("failure");
    expect(POLICY_NAMES).toEqual(["scan", "quota", "retention", "*"]);
    expect(TOKEN_TARGETS).toEqual(["self", "org"]);
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error", "silent"]);
    expect(SCANNER_CLI_RUNTIMES).toEqual(["auto", "docker", "host", "disabled"]);
    expect(AUTH_EMAIL_TOKEN_PURPOSES).toEqual(["password_reset", "oidc_link"]);
    expect(AUTH_EMAIL_TOKEN_PURPOSE.passwordReset).toBe("password_reset");
    expect(AUTH_EMAIL_TOKEN_PURPOSE.oidcLink).toBe("oidc_link");
    expect(EMAIL_TEMPLATES).toBe(AUTH_EMAIL_TOKEN_PURPOSES);
    expect(EMAIL_TEMPLATE).toBe(AUTH_EMAIL_TOKEN_PURPOSE);
  });

  test("narrows shared enum values through canonical guards", () => {
    expect(isRepoKind("hosted")).toBe(true);
    expect(isRepoKind("mirror")).toBe(false);
    expect(isVisibility("public")).toBe(true);
    expect(isVisibility("internal")).toBe(false);
    expect(isAction("write")).toBe(true);
    expect(isAction("publish")).toBe(false);
    expect(isBlobState("pending_delete")).toBe(true);
    expect(isBlobState("deleted")).toBe(false);
    expect(isUploadState("committed")).toBe(true);
    expect(isUploadState("expired")).toBe(false);
    expect(isAuditResult("success")).toBe(true);
    expect(isAuditResult("partial")).toBe(false);
    expect(isPolicyName("retention")).toBe(true);
    expect(isPolicyName("routing")).toBe(false);
    expect(isTokenTarget("org")).toBe(true);
    expect(isTokenTarget("repository")).toBe(false);
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isScannerCliRuntime("docker")).toBe(true);
    expect(isScannerCliRuntime("local")).toBe(false);
    expect(isAuthEmailTokenPurpose("password_reset")).toBe(true);
    expect(isAuthEmailTokenPurpose("invite")).toBe(false);
    expect(isEmailTemplate("oidc_link")).toBe(true);
    expect(isEmailTemplate("newsletter")).toBe(false);
  });

  test("supports registry module ids used across adapters", () => {
    const moduleId: RegistryModuleId = "cargo";
    expect(moduleId).toBe("cargo");
  });
});
