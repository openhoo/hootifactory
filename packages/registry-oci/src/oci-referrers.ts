import { parseRegistryInput } from "@hootifactory/registry";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import {
  manifestAnnotations,
  OciReferrersQuerySchema,
  parseManifestRaw,
  referrerArtifactType,
} from "./oci-validation";

export interface OciReferrerRow {
  mediaType: string;
  digest: string;
  sizeBytes: number;
  raw: string;
}

export interface OciReferrerDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
}

export function parseOciReferrersQuery(url: string): { artifactType?: string } {
  const searchParams = new URL(url).searchParams;
  return parseRegistryInput(
    OciReferrersQuerySchema,
    { artifactType: searchParams.get("artifactType") ?? undefined },
    { code: "MANIFEST_INVALID", message: "invalid referrers query" },
  );
}

export function buildOciReferrerDescriptor(row: OciReferrerRow): OciReferrerDescriptor {
  const parsed = parseManifestRaw(row.raw);
  const artifactType = referrerArtifactType(parsed, row.mediaType);
  const descriptor: OciReferrerDescriptor = {
    mediaType: row.mediaType,
    digest: row.digest,
    size: row.sizeBytes,
  };
  if (artifactType) descriptor.artifactType = artifactType;
  const annotations = manifestAnnotations(parsed);
  if (annotations) descriptor.annotations = annotations;
  return descriptor;
}

export function buildOciReferrersResponse(input: {
  manifests: OciReferrerDescriptor[];
  artifactTypeFilter?: string;
}): Response {
  const headers: Record<string, string> = {
    "content-type": OCI_MEDIA_TYPES.imageIndexV1,
  };
  if (input.artifactTypeFilter) headers["oci-filters-applied"] = "artifactType";
  return new Response(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.imageIndexV1,
      manifests: input.manifests,
    }),
    { status: 200, headers },
  );
}
