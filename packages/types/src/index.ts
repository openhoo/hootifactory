/** Shared types and constants used across packages. */
import { z } from "zod";

export type RegistryModuleId = string;

export type RepoKind = "hosted" | "proxy" | "virtual";
export type Visibility = "private" | "public";

export type Action = "read" | "write" | "delete" | "admin";
export type TokenAction = Action;
export type RoleName = "viewer" | "developer" | "admin" | "owner";
export type PolicyName = "scan" | "quota" | "retention" | "*";
export type TokenTarget = "self" | "org";
export type DenialCode =
  | "unauthenticated"
  | "cross_org"
  | "not_member"
  | "insufficient_scope"
  | "insufficient_role"
  | "forbidden";

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
