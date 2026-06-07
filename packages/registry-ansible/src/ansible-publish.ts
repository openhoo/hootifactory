import { z } from "@hootifactory/registry";
import { extractCollectionManifest } from "./ansible-tarball";
import {
  type CollectionManifest,
  CollectionManifestSchema,
  collectionFqcn,
} from "./ansible-validation";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const AnsibleUploadFieldsSchema = z.strictObject({
  file: z.custom<File>((value) => value instanceof File, { message: "missing file field" }),
});

export interface AnsibleUploadPlan {
  namespace: string;
  name: string;
  version: string;
  fqcn: string;
  manifest: CollectionManifest;
  archiveBytes: Uint8Array;
  scope: string;
  /**
   * The lowercase hex sha256 the client declared in the multipart `sha256` field,
   * or null when it was omitted. The lifecycle verifies it against the stored-blob
   * digest so an upload corrupted in transit is rejected rather than persisted.
   */
  declaredSha256: string | null;
}

export interface AnsibleUploadError {
  code: string;
  message: string;
  status: number;
}

export type AnsibleUploadParseResult =
  | { ok: true; plan: AnsibleUploadPlan }
  | { ok: false; error: AnsibleUploadError };

/** The blob-ref scope for a collection artifact: stable + download-addressable. */
export function ansibleBlobScope(fqcn: string, version: string): string {
  return `${fqcn}@${version}`;
}

/**
 * Parse the multipart publish: read the `file` field, gunzip+untar to find
 * MANIFEST.json, parse namespace/name/version from its `collection_info`.
 * Validation failures are returned (not thrown) so the lifecycle can render the
 * galaxy error envelope with the right status.
 */
export async function parseAnsibleUploadRequest(req: Request): Promise<AnsibleUploadParseResult> {
  let file: File | string | null;
  let sha256Field: File | string | null;
  try {
    const form = await req.formData();
    file = form.get("file");
    sha256Field = form.get("sha256");
  } catch {
    return error("invalid", "expected multipart/form-data upload", 400);
  }

  const fields = AnsibleUploadFieldsSchema.safeParse({ file });
  if (!fields.success) {
    return error("invalid", "missing collection artifact in field 'file'", 400);
  }

  // `ansible-galaxy collection publish` sends the archive's sha256 alongside the
  // file. It is optional here (lenient when absent), but when present it must be a
  // well-formed hex digest the lifecycle can compare against the stored bytes.
  const declared = parseDeclaredSha256(sha256Field);
  if (!declared.ok) return declared.result;

  // Reject empty/oversized uploads from the declared size *before* buffering the
  // whole archive into memory, so a huge upload can't force a giant allocation.
  const uploaded = fields.data.file;
  if (uploaded.size === 0) {
    return error("invalid", "collection artifact is empty", 400);
  }
  if (uploaded.size > MAX_ARCHIVE_BYTES) {
    return error("invalid", "collection artifact is too large", 413);
  }

  const archiveBytes = new Uint8Array(await uploaded.arrayBuffer());
  if (archiveBytes.length === 0) {
    return error("invalid", "collection artifact is empty", 400);
  }
  if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
    return error("invalid", "collection artifact is too large", 413);
  }

  const manifestText = extractCollectionManifest(archiveBytes);
  if (manifestText === null) {
    return error(
      "invalid",
      "artifact is not a valid .tar.gz collection or does not contain a MANIFEST.json",
      400,
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch {
    return error("invalid", "MANIFEST.json is not valid JSON", 400);
  }

  const manifestResult = CollectionManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    return error(
      "invalid",
      "MANIFEST.json is missing a valid collection namespace, name, and version",
      400,
    );
  }
  const manifest = manifestResult.data;
  const { namespace, name, version } = manifest.collection_info;
  const fqcn = collectionFqcn(namespace, name);

  return {
    ok: true,
    plan: {
      namespace,
      name,
      version,
      fqcn,
      manifest,
      archiveBytes,
      scope: ansibleBlobScope(fqcn, version),
      declaredSha256: declared.value,
    },
  };
}

/** A 64-char lowercase hex sha256. */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * Read the optional `sha256` multipart field. Absent -> null (lenient). Present
 * but not a 64-char hex digest -> a galaxy 400. A valid value is lowercased so
 * the lifecycle can compare it case-insensitively against the stored digest.
 */
function parseDeclaredSha256(
  raw: File | string | null,
): { ok: true; value: string | null } | { ok: false; result: AnsibleUploadParseResult } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, result: error("invalid", "sha256 field must be a hex string", 400) };
  }
  const value = raw.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(value)) {
    return { ok: false, result: error("invalid", "sha256 field is not a valid hex digest", 400) };
  }
  return { ok: true, value };
}

function error(code: string, message: string, status: number): AnsibleUploadParseResult {
  return { ok: false, error: { code, message, status } };
}
