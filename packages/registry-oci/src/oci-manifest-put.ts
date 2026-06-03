import { Errors } from "@hootifactory/registry";
import { computeDigest, isValidDigest } from "@hootifactory/storage";
import type { OciManifest } from "@hootifactory/types";
import {
  assertTag,
  type ManifestReference,
  manifestBlobDigests,
  manifestManifestDigests,
  manifestMediaType,
  parseReference,
  validateDescriptor,
  validateManifest,
} from "./oci-validation";
import { bodyBytes } from "./upload-state";

export interface OciManifestPutRequest {
  ref: ManifestReference;
  bytes: Uint8Array;
  raw: string;
  digest: string;
  parsed: OciManifest;
  mediaType: string;
  subjectDigest: string | null;
  referencedBlobs: string[];
  referencedManifests: string[];
  acceptedTags: string[];
}

export async function parseOciManifestPutRequest(
  reference: string,
  req: Request,
): Promise<OciManifestPutRequest> {
  const ref = parseReference(reference);
  const bytes = await bodyBytes(req);
  const digest = computeDigest(bytes);
  if (ref.kind === "digest" && ref.value !== digest) {
    throw Errors.digestInvalid({ expected: reference, got: digest });
  }

  const raw = new TextDecoder().decode(bytes);
  let parsed: OciManifest;
  try {
    parsed = JSON.parse(raw) as OciManifest;
  } catch {
    throw Errors.manifestInvalid();
  }
  const mediaType = manifestMediaType(req, parsed);
  validateManifest(parsed, mediaType);
  if (parsed.subject) validateDescriptor(parsed.subject, "subject");

  const referencedManifests = manifestManifestDigests(raw);
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
    subjectDigest: typeof parsed.subject?.digest === "string" ? parsed.subject.digest : null,
    referencedBlobs: manifestBlobDigests(raw),
    referencedManifests,
    acceptedTags,
  };
}
