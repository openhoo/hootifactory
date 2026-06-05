import { z } from "@hootifactory/registry";
import { extractPubspecYaml } from "./dart-tarball";
import { type DartPubspec, DartPubspecSchema, parsePubspecYaml } from "./dart-validation";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const DartUploadFieldsSchema = z.strictObject({
  file: z.custom<File>((value) => value instanceof File, { message: "missing file field" }),
});

export interface DartUploadPlan {
  packageName: string;
  version: string;
  pubspec: DartPubspec;
  archiveBytes: Uint8Array;
  scope: string;
}

export interface DartUploadError {
  code: string;
  message: string;
  status: number;
}

export type DartUploadParseResult =
  | { ok: true; plan: DartUploadPlan }
  | { ok: false; error: DartUploadError };

/** The blob-ref scope for a package archive: stable and download-route addressable. */
export function dartBlobScope(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

/**
 * Parse the multipart upload: read the `file` field, gunzip+untar to find
 * pubspec.yaml, parse name+version, and compute the archive digest. Validation
 * failures are returned (not thrown) so the lifecycle can render the pub error
 * envelope with the right status.
 */
export async function parseDartUploadRequest(req: Request): Promise<DartUploadParseResult> {
  let file: unknown;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return error("InvalidInput", "expected multipart/form-data upload", 400);
  }

  const fields = DartUploadFieldsSchema.safeParse({ file });
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
    return error("InvalidInput", "archive does not contain a pubspec.yaml", 400);
  }

  const pubspecResult = DartPubspecSchema.safeParse(parsePubspecYaml(pubspecText));
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
      scope: dartBlobScope(pubspec.name, pubspec.version),
    },
  };
}

function error(code: string, message: string, status: number): DartUploadParseResult {
  return { ok: false, error: { code, message, status } };
}
