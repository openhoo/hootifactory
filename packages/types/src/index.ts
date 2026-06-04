/** Shared types and constants used across packages. */
import { z } from "zod";

export type RegistryModuleId = string;

export const REPO_KINDS = ["hosted", "proxy", "virtual"] as const;
export type RepoKind = (typeof REPO_KINDS)[number];
export const VISIBILITIES = ["private", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const ACTIONS = ["read", "write", "delete", "admin"] as const;
export type Action = (typeof ACTIONS)[number];
export type TokenAction = Action;
export const ROLE_NAMES = ["viewer", "developer", "admin", "owner"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export const TOKEN_TYPES = ["personal", "robot"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export const BLOB_STATE = {
  active: "active",
  pendingDelete: "pending_delete",
} as const;
export const BLOB_STATES = [BLOB_STATE.active, BLOB_STATE.pendingDelete] as const;
export type BlobState = (typeof BLOB_STATES)[number];
export const UPLOAD_STATE = {
  open: "open",
  closed: "closed",
  committed: "committed",
  aborted: "aborted",
} as const;
export const UPLOAD_STATES = [
  UPLOAD_STATE.open,
  UPLOAD_STATE.closed,
  UPLOAD_STATE.committed,
  UPLOAD_STATE.aborted,
] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];
export const AUDIT_RESULT = {
  allow: "allow",
  deny: "deny",
  success: "success",
  failure: "failure",
} as const;
export const AUDIT_RESULTS = [
  AUDIT_RESULT.allow,
  AUDIT_RESULT.deny,
  AUDIT_RESULT.success,
  AUDIT_RESULT.failure,
] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
export const POLICY_NAMES = ["scan", "quota", "retention", "*"] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];
export const TOKEN_TARGETS = ["self", "org"] as const;
export type TokenTarget = (typeof TOKEN_TARGETS)[number];
export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const SCANNER_CLI_RUNTIMES = ["auto", "docker", "host", "disabled"] as const;
export type ScannerCliRuntime = (typeof SCANNER_CLI_RUNTIMES)[number];
export const AUTH_EMAIL_TOKEN_PURPOSE = {
  passwordReset: "password_reset",
  oidcLink: "oidc_link",
} as const;
export const AUTH_EMAIL_TOKEN_PURPOSES = [
  AUTH_EMAIL_TOKEN_PURPOSE.passwordReset,
  AUTH_EMAIL_TOKEN_PURPOSE.oidcLink,
] as const;
export type AuthEmailTokenPurpose = (typeof AUTH_EMAIL_TOKEN_PURPOSES)[number];
export const EMAIL_TEMPLATE = AUTH_EMAIL_TOKEN_PURPOSE;
export const EMAIL_TEMPLATES = AUTH_EMAIL_TOKEN_PURPOSES;
export type EmailTemplate = AuthEmailTokenPurpose;
export type DenialCode =
  | "unauthenticated"
  | "cross_org"
  | "not_member"
  | "insufficient_scope"
  | "insufficient_role"
  | "forbidden";

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export function isRepoKind(value: unknown): value is RepoKind {
  return isOneOf(REPO_KINDS, value);
}

export function isVisibility(value: unknown): value is Visibility {
  return isOneOf(VISIBILITIES, value);
}

export function isAction(value: unknown): value is Action {
  return isOneOf(ACTIONS, value);
}

export function isRoleName(value: unknown): value is RoleName {
  return isOneOf(ROLE_NAMES, value);
}

export function isBlobState(value: unknown): value is BlobState {
  return isOneOf(BLOB_STATES, value);
}

export function isUploadState(value: unknown): value is UploadState {
  return isOneOf(UPLOAD_STATES, value);
}

export function isAuditResult(value: unknown): value is AuditResult {
  return isOneOf(AUDIT_RESULTS, value);
}

export function isPolicyName(value: unknown): value is PolicyName {
  return isOneOf(POLICY_NAMES, value);
}

export function isTokenTarget(value: unknown): value is TokenTarget {
  return isOneOf(TOKEN_TARGETS, value);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return isOneOf(LOG_LEVELS, value);
}

export function isScannerCliRuntime(value: unknown): value is ScannerCliRuntime {
  return isOneOf(SCANNER_CLI_RUNTIMES, value);
}

export function isAuthEmailTokenPurpose(value: unknown): value is AuthEmailTokenPurpose {
  return isOneOf(AUTH_EMAIL_TOKEN_PURPOSES, value);
}

export function isEmailTemplate(value: unknown): value is EmailTemplate {
  return isOneOf(EMAIL_TEMPLATES, value);
}

/** Legacy repository-scope token shape accepted by pre-v1 UI/API callers. */
export interface TokenScope {
  repository: string;
  actions: TokenAction[];
}

export type TokenGrant =
  | { resource: "org"; actions: TokenAction[] }
  | { resource: "repository"; repository: string; actions: TokenAction[] }
  | { resource: "package"; repository: string; package: string; actions: TokenAction[] }
  | { resource: "artifact"; repository: string; artifact: string; actions: TokenAction[] }
  | { resource: "policy"; policy: PolicyName; repository?: string; actions: TokenAction[] }
  | { resource: "token"; target: TokenTarget; actions: TokenAction[] };

/** An OCI Bearer-token access claim authorized at /token issue time. */
export interface RegistryAccess {
  type: string;
  name: string;
  actions: string[];
}

/** Normalized identity after authentication; every delivery adapter converges here. */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; username: string }
  | {
      kind: "token";
      tokenId: string;
      orgId: string;
      ownerUserId: string | null;
      ownerUsername?: string | null;
      tokenName?: string;
      grants: TokenGrant[];
      scopes: TokenScope[];
      role: RoleName | null;
      isRobot: boolean;
    }
  | { kind: "registryToken"; subject: string; access: RegistryAccess[] };

export type ResourceType =
  | "org"
  | "repository"
  | "package"
  | "artifact"
  | "policy"
  | "token"
  | "system";

export interface ResourceRef {
  type: ResourceType;
  /** Resolved from the DB, never trusted from a request path. */
  orgId?: string;
  repositoryId?: string;
  /** Used for token-grant matching, e.g. "acme/app" or "@scope/pkg". */
  repositoryName?: string;
  packageName?: string;
  artifactRef?: string;
  policy?: PolicyName;
  tokenTarget?: TokenTarget;
  tokenId?: string;
  visibility?: Visibility;
}

export interface Decision {
  allowed: boolean;
  code?: DenialCode;
  reason?: string;
}

/** OCI / Docker manifest + config media types. */
export const OCI_MEDIA_TYPES = {
  manifestV1: "application/vnd.oci.image.manifest.v1+json",
  imageIndexV1: "application/vnd.oci.image.index.v1+json",
  configV1: "application/vnd.oci.image.config.v1+json",
  layerTarGzip: "application/vnd.oci.image.layer.v1.tar+gzip",
  emptyV1: "application/vnd.oci.empty.v1+json",
  dockerManifestV2: "application/vnd.docker.distribution.manifest.v2+json",
  dockerManifestListV2: "application/vnd.docker.distribution.manifest.list.v2+json",
  dockerConfigV1: "application/vnd.docker.container.image.v1+json",
  dockerLayerGzip: "application/vnd.docker.image.rootfs.diff.tar.gzip",
} as const;

/** An OCI content descriptor. */
export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  urls?: string[];
  annotations?: Record<string, string>;
  artifactType?: string;
  platform?: { architecture: string; os: string; variant?: string };
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  artifactType?: string;
  config?: OciDescriptor;
  layers?: OciDescriptor[];
  blobs?: OciDescriptor[];
  manifests?: OciDescriptor[];
  subject?: OciDescriptor;
  annotations?: Record<string, string>;
}

const OciReferenceDescriptorSchema = z.looseObject({ digest: z.string() });
const OciReferenceManifestSchema = z.looseObject({
  config: z.unknown().optional(),
  layers: z.array(z.unknown()).optional(),
  blobs: z.array(z.unknown()).optional(),
  manifests: z.array(z.unknown()).optional(),
});

function addDescriptorDigest(out: Set<string>, descriptor: unknown): void {
  const parsed = OciReferenceDescriptorSchema.safeParse(descriptor);
  if (parsed.success) out.add(parsed.data.digest);
}

export interface OciManifestReferenceLists {
  blobs: string[];
  manifests: string[];
}

type JsonParseResult = { success: true; data: unknown } | { success: false };

function safeJsonParse(raw: string): JsonParseResult {
  try {
    return { success: true, data: JSON.parse(raw) };
  } catch {
    return { success: false };
  }
}

export function ociManifestReferencesFromValue(value: unknown): OciManifestReferenceLists {
  const parsed = OciReferenceManifestSchema.safeParse(value);
  if (!parsed.success) return { blobs: [], manifests: [] };
  const blobs = new Set<string>();
  const manifests = new Set<string>();
  addDescriptorDigest(blobs, parsed.data.config);
  for (const layer of parsed.data.layers ?? []) addDescriptorDigest(blobs, layer);
  for (const blob of parsed.data.blobs ?? []) addDescriptorDigest(blobs, blob);
  for (const manifest of parsed.data.manifests ?? []) addDescriptorDigest(manifests, manifest);
  return { blobs: [...blobs], manifests: [...manifests] };
}

export function ociManifestReferences(raw: string): OciManifestReferenceLists {
  const parsed = safeJsonParse(raw);
  return parsed.success
    ? ociManifestReferencesFromValue(parsed.data)
    : { blobs: [], manifests: [] };
}
