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
  isRoleName,
  isScannerCliRuntime,
  isTokenTarget,
  isUploadState,
  isVisibility,
  LOG_LEVELS,
  OCI_MEDIA_TYPES,
  type OciManifest,
  ociManifestReferences,
  ociManifestReferencesFromValue,
  POLICY_NAMES,
  REPO_KINDS,
  type RegistryModuleId,
  ROLE_NAMES,
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
    expect(ROLE_NAMES).toEqual(["viewer", "developer", "admin", "owner"]);
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
    expect(isRoleName("developer")).toBe(true);
    expect(isRoleName("superuser")).toBe(false);
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

  test("keeps OCI and Docker media type constants stable", () => {
    expect(OCI_MEDIA_TYPES.manifestV1).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(OCI_MEDIA_TYPES.dockerManifestV2).toBe(
      "application/vnd.docker.distribution.manifest.v2+json",
    );
    expect(OCI_MEDIA_TYPES.dockerLayerGzip).toBe(
      "application/vnd.docker.image.rootfs.diff.tar.gzip",
    );
  });

  test("supports registry module ids and manifest shapes used across adapters", () => {
    const moduleId: RegistryModuleId = "cargo";
    const manifest: OciManifest = {
      schemaVersion: 2,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: "sha256:test", size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: "sha256:layer", size: 10 }],
    };

    expect(moduleId).toBe("cargo");
    expect(manifest.layers?.[0]?.mediaType).toBe(OCI_MEDIA_TYPES.layerTarGzip);
  });

  test("extracts OCI artifact blob descriptors separately from child manifests", () => {
    const refs = ociManifestReferences(
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: "sha256:config", size: 2 },
        layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: "sha256:layer", size: 10 }],
        blobs: [
          {
            mediaType: "application/vnd.example.payload",
            digest: "sha256:artifact-blob",
            size: 12,
          },
        ],
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.manifestV1,
            digest: "sha256:child-manifest",
            size: 123,
          },
        ],
      }),
    );

    expect(refs.blobs).toEqual(["sha256:config", "sha256:layer", "sha256:artifact-blob"]);
    expect(refs.manifests).toEqual(["sha256:child-manifest"]);
  });

  test("extracts OCI references from an already parsed manifest value", () => {
    const manifestValue = {
      schemaVersion: 2,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: "sha256:config", size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: "sha256:layer", size: 10 }],
      manifests: [
        {
          mediaType: OCI_MEDIA_TYPES.manifestV1,
          digest: "sha256:child-manifest",
          size: 123,
        },
      ],
    };

    expect(ociManifestReferencesFromValue(manifestValue)).toEqual({
      blobs: ["sha256:config", "sha256:layer"],
      manifests: ["sha256:child-manifest"],
    });
    expect(ociManifestReferencesFromValue(JSON.stringify(manifestValue))).toEqual({
      blobs: [],
      manifests: [],
    });
  });

  test("ignores non-object manifests and malformed descriptor entries", () => {
    expect(ociManifestReferences("[]")).toEqual({ blobs: [], manifests: [] });
    expect(ociManifestReferences("{not json")).toEqual({ blobs: [], manifests: [] });
    expect(
      ociManifestReferences(
        JSON.stringify({
          config: { digest: "sha256:config" },
          layers: [{ digest: 123 }, null, { digest: "sha256:layer" }],
          manifests: [{ digest: "sha256:child" }, { mediaType: "missing digest" }],
        }),
      ),
    ).toEqual({
      blobs: ["sha256:config", "sha256:layer"],
      manifests: ["sha256:child"],
    });
  });
});
