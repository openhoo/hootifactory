import {
  Errors,
  isValidDigest,
  parseJsonWithSchema,
  parseRegistryInput,
  z,
} from "@hootifactory/registry";
import {
  OCI_MEDIA_TYPES,
  type OciDescriptor,
  type OciManifestReferenceLists,
  ociManifestReferences,
  ociManifestReferencesFromValue,
} from "@hootifactory/types";

const OCI_ARTIFACT_MANIFEST_MEDIA_TYPE = "application/vnd.oci.artifact.manifest.v1+json";
const SUPPORTED_MANIFEST_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.manifestV1,
  OCI_MEDIA_TYPES.imageIndexV1,
  OCI_MEDIA_TYPES.dockerManifestV2,
  OCI_MEDIA_TYPES.dockerManifestListV2,
  OCI_ARTIFACT_MANIFEST_MEDIA_TYPE,
]);
const IMAGE_MANIFEST_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.manifestV1,
  OCI_MEDIA_TYPES.dockerManifestV2,
]);
const IMAGE_INDEX_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.imageIndexV1,
  OCI_MEDIA_TYPES.dockerManifestListV2,
]);
export const MAX_OCI_DESCRIPTOR_ARRAY_ITEMS = 4096;

const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const NAME_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

export const OciImageNameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(NAME_RE, "invalid OCI image name");
export const OciTagSchema = z.string().min(1).max(128).regex(TAG_RE, "invalid OCI tag");
export const OciDigestSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidDigest, "invalid OCI digest");
export const UploadUuidSchema = z.uuid();
export const OciTagPageSizeSchema = z.coerce.number().int().min(0).max(10_000);
export const OciReferrersQuerySchema = z.strictObject({
  artifactType: z.string().min(1).max(255).optional(),
});
export const OciStartUploadQuerySchema = z.strictObject({
  digest: OciDigestSchema.optional(),
  mount: OciDigestSchema.optional(),
  from: OciImageNameSchema.optional(),
});
export const OciCommitUploadQuerySchema = z.strictObject({
  digest: OciDigestSchema,
});

const ManifestReferenceSchema = z.string().min(1).max(256);
const ContentRangeHeaderSchema = z
  .string()
  .trim()
  .regex(/^(?:bytes\s+)?\d+-\d+(?:\/(?:\d+|\*))?$/i);
const BlobRangeHeaderSchema = z
  .string()
  .trim()
  .regex(/^bytes=\d*-\d*$/i)
  .refine((value) => !value.includes(","), "multiple ranges are not supported");
const OciManifestObjectSchema = z.record(z.string(), z.unknown());
const OciDescriptorSchema = z.looseObject({
  mediaType: z.string().min(1).max(255),
  digest: OciDigestSchema,
  size: z.number().int().safe().min(0),
  urls: z.array(z.url()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  artifactType: z.string().min(1).max(255).optional(),
  platform: z
    .looseObject({
      architecture: z.string().min(1).max(64),
      os: z.string().min(1).max(64),
      variant: z.string().min(1).max(64).optional(),
    })
    .optional(),
});

export type ManifestReference = { kind: "digest" | "tag"; value: string };
export type OciManifestDocument = z.output<typeof OciManifestObjectSchema>;

export function assertImageName(name: string): void {
  parseRegistryInput(OciImageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid image name",
  });
}

export function parseReference(reference: string): ManifestReference {
  parseRegistryInput(ManifestReferenceSchema, reference, {
    code: "NAME_INVALID",
    message: "invalid manifest reference",
  });
  if (isValidDigest(reference)) return { kind: "digest", value: reference };
  if (reference.startsWith("sha256:")) throw Errors.digestInvalid({ reference });
  parseRegistryInput(OciTagSchema, reference, { code: "TAG_INVALID", message: "invalid tag" });
  return { kind: "tag", value: reference };
}

export function assertTag(tag: string): void {
  parseRegistryInput(OciTagSchema, tag, { code: "TAG_INVALID", message: "invalid tag" });
}

function normalizeMediaType(value: string | null | undefined): string | null {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return mediaType || null;
}

export function acceptsMediaType(acceptHeader: string | null, mediaType: string): boolean {
  if (!acceptHeader?.trim()) return true;
  const normalized = normalizeMediaType(mediaType);
  if (!normalized) return false;

  for (const item of acceptHeader.split(",")) {
    const [rangeRaw, ...parameterParts] = item.split(";");
    const range = rangeRaw?.trim().toLowerCase();
    if (!range) continue;

    const q = parameterParts.reduce<number>((quality, part) => {
      const [key, value] = part.split("=").map((s) => s.trim().toLowerCase());
      if (key !== "q" || !value) return quality;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : quality;
    }, 1);
    if (q <= 0) continue;

    if (range === normalized || range === "*/*") return true;
    if (range.endsWith("/*") && normalized.startsWith(range.slice(0, -1))) return true;
  }
  return false;
}

export function validateDescriptor(value: unknown, field: string): OciDescriptor {
  const parsed = OciDescriptorSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const invalidDigest = parsed.error.issues.some((issue) => issue.path.join(".") === "digest");
  const invalidSize = parsed.error.issues.some((issue) => issue.path.join(".") === "size");
  if (invalidDigest) throw Errors.digestInvalid({ reason: `${field}.digest is invalid` });
  if (invalidSize) throw Errors.sizeInvalid({ reason: `${field}.size is invalid` });
  throw Errors.manifestInvalid({ reason: `${field} must be a valid descriptor` });
}

function validateDescriptorArray(value: unknown, field: string): OciDescriptor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Errors.manifestInvalid({ reason: `${field} must be an array` });
  if (value.length > MAX_OCI_DESCRIPTOR_ARRAY_ITEMS) {
    throw Errors.manifestInvalid({
      reason: `${field} must contain at most ${MAX_OCI_DESCRIPTOR_ARRAY_ITEMS} descriptors`,
    });
  }
  return value.map((descriptor, i) => validateDescriptor(descriptor, `${field}[${i}]`));
}

export function manifestMediaType(req: Request, parsed: OciManifestDocument): string {
  const contentType = normalizeMediaType(req.headers.get("content-type"));
  const bodyMediaType =
    typeof parsed.mediaType === "string" ? normalizeMediaType(parsed.mediaType) : null;
  const mediaType = contentType ?? bodyMediaType;
  if (!mediaType) throw Errors.manifestInvalid({ reason: "manifest media type is required" });
  if (!SUPPORTED_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    throw Errors.unsupported({ reason: "unsupported manifest media type", mediaType });
  }
  if (bodyMediaType && bodyMediaType !== mediaType) {
    throw Errors.manifestInvalid({
      reason: "content-type does not match manifest mediaType",
      contentType: mediaType,
      mediaType: bodyMediaType,
    });
  }
  return mediaType;
}

export function validateManifest(parsed: OciManifestDocument, mediaType: string): void {
  if (parsed.schemaVersion !== 2) {
    throw Errors.manifestInvalid({ reason: "schemaVersion must be 2" });
  }
  if (IMAGE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    validateDescriptor(parsed.config, "config");
    if (!Array.isArray(parsed.layers)) {
      throw Errors.manifestInvalid({ reason: "layers must be an array" });
    }
    validateDescriptorArray(parsed.layers, "layers");
    return;
  }
  if (IMAGE_INDEX_MEDIA_TYPES.has(mediaType)) {
    if (!Array.isArray(parsed.manifests)) {
      throw Errors.manifestInvalid({ reason: "manifests must be an array" });
    }
    validateDescriptorArray(parsed.manifests, "manifests");
    return;
  }
  if (mediaType === OCI_ARTIFACT_MANIFEST_MEDIA_TYPE) {
    if (parsed.artifactType !== undefined && typeof parsed.artifactType !== "string") {
      throw Errors.manifestInvalid({ reason: "artifactType must be a string" });
    }
    validateDescriptorArray(parsed.blobs, "blobs");
    return;
  }
}

function parseManifestJson(raw: string): OciManifestDocument | null {
  return parseJsonWithSchema(OciManifestObjectSchema, raw);
}

export function parseManifestRequestRaw(raw: string): OciManifestDocument {
  const parsed = parseManifestJson(raw);
  if (!parsed) throw Errors.manifestInvalid({ reason: "manifest must be a JSON object" });
  return parsed;
}

export function parseManifestRaw(raw: string): OciManifestDocument {
  return parseManifestJson(raw) ?? { schemaVersion: 2 };
}

export function referrerArtifactType(
  manifest: OciManifestDocument,
  mediaType: string,
): string | undefined {
  if (typeof manifest.artifactType === "string" && manifest.artifactType.length > 0) {
    return manifest.artifactType;
  }
  const config = OciManifestObjectSchema.safeParse(manifest.config);
  if (
    IMAGE_MANIFEST_MEDIA_TYPES.has(mediaType) &&
    config.success &&
    typeof config.data.mediaType === "string" &&
    config.data.mediaType.length > 0
  ) {
    return config.data.mediaType;
  }
  return undefined;
}

export function manifestAnnotations(
  manifest: OciManifestDocument,
): Record<string, string> | undefined {
  const parsed = z.record(z.string(), z.string()).safeParse(manifest.annotations);
  if (!parsed.success) return undefined;
  const annotations = parsed.data;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function parseContentRange(value: string | null): { start: number; end: number } | null {
  if (!value) return null;
  const parsed = ContentRangeHeaderSchema.safeParse(value);
  if (!parsed.success)
    throw Errors.blobUploadInvalid({ reason: "invalid content-range", contentRange: value });
  const match = /^(?:bytes\s+)?(\d+)-(\d+)(?:\/(?:\d+|\*))?$/i.exec(parsed.data);
  if (!match)
    throw Errors.blobUploadInvalid({ reason: "invalid content-range", contentRange: value });
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw Errors.blobUploadInvalid({ reason: "invalid content-range", contentRange: value });
  }
  return { start, end };
}

export function validateContentRange(
  req: Request,
  expectedStart: number,
  chunkLength: number,
): void {
  const contentRange = req.headers.get("content-range");
  if (!contentRange) return;
  if (chunkLength === 0) {
    throw Errors.blobUploadInvalid({ reason: "content-range with empty chunk", contentRange });
  }
  const range = parseContentRange(contentRange);
  const expectedEnd = expectedStart + chunkLength - 1;
  if (!range || range.start !== expectedStart || range.end !== expectedEnd) {
    throw Errors.blobUploadInvalid({
      reason: "content-range does not match upload offset",
      expected: `${expectedStart}-${expectedEnd}`,
      got: contentRange,
    });
  }
}

export function parseBlobRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const parsed = BlobRangeHeaderSchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.blobUploadInvalid({ reason: "invalid range", range: value });
  }
  const trimmed = parsed.data;
  const spec = trimmed.slice("bytes=".length);
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) throw Errors.blobUploadInvalid({ reason: "invalid range", range: value });

  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && !endRaw)
    throw Errors.blobUploadInvalid({ reason: "invalid range", range: value });

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
      throw Errors.blobUploadInvalid({ reason: "unsatisfiable range", range: value });
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  const requestedEnd = endRaw ? Number(endRaw) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start > requestedEnd ||
    start >= size
  ) {
    throw Errors.blobUploadInvalid({ reason: "unsatisfiable range", range: value });
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * The CAS blob digests an image manifest references (its config + layers). Index
 * / manifest-list manifests reference sub-manifests (not blobs). OCI artifact
 * manifests reference payloads through `blobs`.
 */
export function manifestBlobDigests(raw: string): string[] {
  return ociManifestReferences(raw).blobs;
}

export function manifestManifestDigests(raw: string): string[] {
  return ociManifestReferences(raw).manifests;
}

export function manifestReferences(manifest: unknown): OciManifestReferenceLists {
  return ociManifestReferencesFromValue(manifest);
}
