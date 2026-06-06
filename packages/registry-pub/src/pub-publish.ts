import { z } from "@hootifactory/registry";
import { extractPubspecYaml } from "./pub-tarball";
import { type Pubspec, PubspecSchema, parsePubspecYaml } from "./pub-validation";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const PubUploadFieldsSchema = z.strictObject({
  file: z.custom<File>((value) => value instanceof File, { message: "missing file field" }),
});

export interface PubUploadPlan {
  packageName: string;
  version: string;
  pubspec: Pubspec;
  archiveBytes: Uint8Array;
  scope: string;
}

export interface PubUploadError {
  code: string;
  message: string;
  status: number;
}

export type PubUploadParseResult =
  | { ok: true; plan: PubUploadPlan }
  | { ok: false; error: PubUploadError };

/** The blob-ref scope for a package archive: stable and download-route addressable. */
export function pubBlobScope(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

/**
 * Parse the multipart upload: read the `file` field, gunzip+untar to find
 * pubspec.yaml, parse name+version, and compute the archive digest. Validation
 * failures are returned (not thrown) so the lifecycle can render the pub error
 * envelope with the right status.
 */
export async function parsePubUploadRequest(req: Request): Promise<PubUploadParseResult> {
  let file: unknown;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return error("InvalidInput", "expected multipart/form-data upload", 400);
  }

  const fields = PubUploadFieldsSchema.safeParse({ file });
  if (!fields.success) {
    return error("InvalidInput", "missing package archive in field 'file'", 400);
  }

  const archiveBytes = new Uint8Array(await fields.data.file.arrayBuffer());
  if (archiveBytes.length === 0) {
    return error("InvalidInput", "package archive is empty", 400);
  }
  if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
    return error("InvalidInput", "package archive is too large", 413);
  }

  const pubspecText = extractPubspecYaml(archiveBytes);
  if (pubspecText === null) {
    return error(
      "InvalidInput",
      "archive is not a valid .tar.gz package or does not contain a pubspec.yaml",
      400,
    );
  }

  const pubspecResult = PubspecSchema.safeParse(parsePubspecYaml(pubspecText));
  if (!pubspecResult.success) {
    return error("InvalidInput", "pubspec.yaml is missing a valid name and version", 400);
  }
  const pubspec = pubspecResult.data;

  return {
    ok: true,
    plan: {
      packageName: pubspec.name,
      version: pubspec.version,
      pubspec,
      archiveBytes,
      scope: pubBlobScope(pubspec.name, pubspec.version),
    },
  };
}

function error(code: string, message: string, status: number): PubUploadParseResult {
  return { ok: false, error: { code, message, status } };
}
