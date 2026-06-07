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
  let file: unknown;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return error("invalid", "expected multipart/form-data upload", 400);
  }

  const fields = AnsibleUploadFieldsSchema.safeParse({ file });
  if (!fields.success) {
    return error("invalid", "missing collection artifact in field 'file'", 400);
  }

  const archiveBytes = new Uint8Array(await fields.data.file.arrayBuffer());
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
    },
  };
}

function error(code: string, message: string, status: number): AnsibleUploadParseResult {
  return { ok: false, error: { code, message, status } };
}
