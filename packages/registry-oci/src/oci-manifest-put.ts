import { computeDigest, Errors, isValidDigest, RegistryError } from "@hootifactory/registry";
import {
  assertTag,
  type ManifestReference,
  manifestMediaType,
  manifestReferences,
  type OciManifestDocument,
  parseManifestRequestRaw,
  parseReference,
  validateDescriptor,
  validateManifest,
} from "./oci-validation";
import { bodyBytes } from "./upload-state";

export const MAX_OCI_MANIFEST_BYTES = 10 * 1024 * 1024;

export interface OciManifestPutRequest {
  ref: ManifestReference;
  bytes: Uint8Array;
  raw: string;
  digest: string;
  parsed: OciManifestDocument;
  mediaType: string;
  subjectDigest: string | null;
  configDigest: string | null;
  referencedBlobs: string[];
  referencedManifests: string[];
  acceptedTags: string[];
}

export async function parseOciManifestPutRequest(
  reference: string,
  req: Request,
): Promise<OciManifestPutRequest> {
  const ref = parseReference(reference);
  const contentLength = Number(req.headers.get("content-length"));
  if (contentLength > MAX_OCI_MANIFEST_BYTES) {
    throw new RegistryError(413, "MANIFEST_INVALID", "manifest body exceeds maximum size", {
      maxBytes: MAX_OCI_MANIFEST_BYTES,
      actualBytes: contentLength,
    });
  }
  const bytes = await bodyBytes(req);
  const digest = computeDigest(bytes);
  if (ref.kind === "digest" && ref.value !== digest) {
    throw Errors.digestInvalid({ expected: reference, got: digest });
  }

  const raw = new TextDecoder().decode(bytes);
  const parsed = parseManifestRequestRaw(raw);
  const mediaType = manifestMediaType(req, parsed);
  validateManifest(parsed, mediaType);
  const subject =
    parsed.subject === undefined ? null : validateDescriptor(parsed.subject, "subject");
  const config = parsed.config === undefined ? null : validateDescriptor(parsed.config, "config");

  const references = manifestReferences(parsed);
  const referencedManifests = references.manifests;
  for (const manifestDigest of referencedManifests) {
    if (!isValidDigest(manifestDigest)) {
      throw Errors.digestInvalid({ reason: "manifest descriptor digest is invalid" });
    }
  }

  const acceptedTags =
    ref.kind === "tag" ? [ref.value] : [...new Set(new URL(req.url).searchParams.getAll("tag"))];
  for (const tag of acceptedTags) assertTag(tag);

  return {
    ref,
    bytes,
    raw,
    digest,
    parsed,
    mediaType,
    subjectDigest: subject?.digest ?? null,
    configDigest: config?.digest ?? null,
    referencedBlobs: references.blobs,
    referencedManifests,
    acceptedTags,
  };
}
