/** Shared types and constants used across packages. */
import { z } from "zod";

export type RegistryModuleId = string;

export type RepoKind = "hosted" | "proxy" | "virtual";
export type Visibility = "private" | "public";

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
